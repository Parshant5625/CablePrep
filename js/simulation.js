/* ==========================================================================
 * CablePrep  —  js/simulation.js
 * THE BRAIN OF THE VIRTUAL MACHINE
 * Owner: Person 1 — Engineering / Control
 * Design source of truth: docs/machine-workflow.md (v0.1.1)
 * --------------------------------------------------------------------------
 * THIS IS THE ONLY FILE THAT:
 *   - owns the machine state
 *   - makes state transitions
 *   - reads sensor values
 *   - decides what the actuators should do
 *   - detects and raises faults
 *   - performs the inspection decision
 *   - builds the public machineData object
 *
 * sensors.js reports. machine.js obeys. simulation.js decides.
 * ========================================================================== */

/* ==========================================================================
 * MACHINE_CONFIG  (workflow Section 15)
 *
 *  >>> READ THIS BEFORE TRUSTING ANY NUMBER BELOW <<<
 *
 * Every value marked [SIM] is a SIMULATION ASSUMPTION chosen by us so the
 * machine has something to work with. Every value marked [STD?] is a
 * PLACEHOLDER that must be verified against the official standard before
 * anyone may claim IS 10810 compliance.
 *
 * This object is the ONLY place numbers live. Change a value here and the
 * whole machine changes with it — no code changes needed.
 * ========================================================================== */
const MACHINE_CONFIG = {

  /* ---- Timing ------------------------------------------------------ */
  simulationIntervalMs: 50,          // [SIM] the machine "tick"

  /* ---- Feed axis (A1 feed motor, A2 feed rollers) -------------------
   * RULE: every timeout must be LONGER than the theoretical time the step
   * needs, or the machine faults during perfectly normal operation.
   *   feed time = feedDistanceMm / feedSpeedMmPerSec
   *             = 250 / 25 = 10000 ms  -> the timeout must exceed that.
   * feedTimeoutMs is 15000 ms, giving 50% headroom.
   * ------------------------------------------------------------------ */
  feedSpeedMmPerSec: 25,             // [SIM]
  feedDistanceMm: 250,               // [SIM] target feed distance
  maxTravelMm: 500,                  // [SIM] physical end of the axis
  feedTimeoutMs: 15000,              // [SIM] MUST exceed 10000 ms (see rule above)

  /* ---- Encoder (S3) ------------------------------------------------- */
  encoderPulsesPerMm: 4,             // [SIM] must match real encoder datasheet
  encoderToleranceMm: 0.5,           // [SIM] allowed S2 vs S3 disagreement

  /* ---- Cable detection (S1) ----------------------------------------- */
  cableDetectStableTicks: 3,         // [SIM] debounce
  cableDetectTimeoutMs: 2000,        // [SIM] max wait for a cable

  /* ---- Alignment (S4, done by the feed rollers in align mode) ------- */
  alignJogMm: 2,                     // [SIM] one corrective jog
  alignJogStepsToStraight: 3,        // [SIM] jogs needed to straighten the cable
  alignStableTicks: 3,               // [SIM] debounce
  alignmentTimeoutMs: 3000,          // [SIM] max time in ALIGNING

  /* ---- Measuring + cutting ------------------------------------------ */
  cuttingPositionMm: 250,            // [SIM]
  cutPositionToleranceMm: 1,         // [SIM] "close enough to the cutter"
  cutterStrokeMs: 800,               // [SIM]
  cutterTimeoutMs: 2000,             // [SIM] must exceed cutterStrokeMs
  measuringTimeoutMs: 3000,          // [SIM] max time waiting for cut position
  targetSpecimenLengthMm: 250,       // [STD?] nominal specimen length
  lengthToleranceMm: 2,              // [STD?] allowed cut-length deviation

  /* ---- Preparation (A4) --------------------------------------------- */
  preparationDurationMs: 1500,       // [SIM]
  preparationTimeoutMs: 4000,        // [SIM]
  preparationStableTicks: 2,         // [SIM] debounce
  preparationDepthMm: 30,            // [STD?] standard-critical — PLACEHOLDER

  /* ---- Specimen axis (A5) ------------------------------------------- */
  specimenSpeedMmPerSec: 40,         // [SIM]
  formingDwellMs: 500,               // [SIM] clamp/settle time
  formingTimeoutMs: 6000,            // [SIM]
  homingTimeoutMs: 5000,             // [SIM]
  formingStationToleranceMm: 2,      // [SIM] "arrived at station" band
  stationPositions: {                // [SIM] the machine layout
    cutter: 0,
    forming: 150,
    vision: 300,
    outTray: 400,
    rejectTray: 450
  },

  /* ---- Vision (S8) --------------------------------------------------
   * goodMeasurement and visionRange are PLACEHOLDERS. The PASS/REJECT
   * MECHANISM is correct; the NUMBERS are not engineering values yet.
   * ------------------------------------------------------------------ */
  goodMeasurement: { length: 250.0, width: 10.0, thickness: 1.75 },   // [STD?]
  visionRange: {                    // [STD?] PLACEHOLDER — verify vs standard
    length:    { min: 248.0, max: 252.0 },
    width:     { min: 9.5,   max: 10.5 },
    thickness: { min: 1.50,  max: 2.00 }
  },

  /* ---- Result handling ---------------------------------------------- */
  resultStoreDelayMs: 200,           // [SIM] time to "write" a result record
  completeDwellMs: 400,              // [SIM] pause in COMPLETE before IDLE
  maxEventLog: 200                   // ring-buffer size for the HMI log
};

// CONFIG is aliased once here, at module scope, because BOTH the STATES
// table below and the Simulation module body need to read it.
const CONFIG = MACHINE_CONFIG;

/* ==========================================================================
 * FAULT CODES  (workflow Section 9 — the table is the source of truth)
 * Keyed by code so that a fault message can never drift from its code.
 * ========================================================================== */
const FAULT_CODES = {
  CABLE_NOT_DETECTED:    'No cable detected at the loading station',
  CABLE_LOST:            'Cable lost during feeding',
  MISALIGNMENT:          'Cable could not be aligned within the allowed time',
  LENGTH_OUT_OF_TOLERANCE:'Measured cut length is outside the configured tolerance band',
  SENSOR_FAILURE:        'A sensor reported a failure or an implausible value',
  INTERLOCK_OPEN:        'Safety interlock is not satisfied',
  CUTTING_FAILURE:       'Cutter did not complete the cut',
  PREPARATION_FAILURE:   'Preparation stage did not complete',
  SPECIMEN_NOT_PLACED:   'Specimen did not reach the vision station',
  VISION_FAILURE:        'Vision system failed to produce a measurement',
  ENCODER_MISMATCH:      'Encoder and position sensor disagree',
  FEED_TIMEOUT:          'Cable did not reach the feed target within the allowed time',
  HOMING_TIMEOUT:        'Specimen axis did not reach the home position in time',
  ESTOP_ACTIVE:          'Emergency stop was activated',
  RESET_BLOCKED:         'Reset refused because the cause still exists'
};

/* ==========================================================================
 * THE STATES  (workflow Section 6 — exactly the 14 from the brief, no more)
 *
 * `next` lists the ONLY legal destinations. A transition to anything else
 * is refused by changeState(). This is what stops the machine skipping a
 * step, which is the single most important safety property here.
 * ========================================================================== */
const STATES = {
  IDLE: {
    next: ['INITIALIZING', 'FAULT'],
    timeoutMs: 0,
    enter: function () { Machine.allOff(); }
  },
  INITIALIZING: {
    next: ['CABLE_DETECTED', 'FAULT'],
    timeoutMs: function () { return CONFIG.homingTimeoutMs; },
    enter: function () { Machine.moveTo('cutter'); }   // home the specimen axis
  },
  CABLE_DETECTED: {
    next: ['FEEDING', 'FAULT'],
    timeoutMs: function () { return CONFIG.cableDetectTimeoutMs; },
    enter: function () { /* decision state — no actuator runs here */ }
  },
  FEEDING: {
    next: ['ALIGNING', 'FAULT'],
    timeoutMs: function () { return CONFIG.feedTimeoutMs; },
    enter: function () {
      Machine.set('feedRollers', true, 'feed');
      Machine.set('feedMotor', true);
    },
    exit: function () {
      Machine.set('feedMotor', false);
      Machine.set('feedRollers', false);
    }
  },
  ALIGNING: {
    next: ['MEASURING', 'FAULT'],
    timeoutMs: function () { return CONFIG.alignmentTimeoutMs; },
    enter: function () {
      Machine.set('feedMotor', false);              // feeding is finished
      Machine.set('feedRollers', true, 'align');     // rollers straighten it
    },
    exit: function () { Machine.set('feedRollers', false); }
  },
  MEASURING: {
    next: ['CUTTING', 'FAULT'],
    timeoutMs: function () { return CONFIG.measuringTimeoutMs; },
    enter: function () { Machine.allOff(); },        // nothing moves while measuring
    exit: function () { /* nothing to release */ }
  },
  CUTTING: {
    next: ['PREPARING', 'FAULT'],
    timeoutMs: function () { return CONFIG.cutterTimeoutMs; },
    enter: function () { Machine.set('cutter', true); },
    exit: function () { Machine.set('cutter', false); }
  },
  PREPARING: {
    next: ['FORMING', 'FAULT'],
    timeoutMs: function () { return CONFIG.preparationTimeoutMs; },
    enter: function () { Machine.set('preparation', true); },
    exit: function () { Machine.set('preparation', false); }
  },
  FORMING: {
    next: ['INSPECTING', 'FAULT'],
    timeoutMs: function () { return CONFIG.formingTimeoutMs; },
    enter: function () { Machine.moveTo('forming'); },
    exit: function () { /* axis stops on arrival by itself */ }
  },
  INSPECTING: {
    next: ['ACCEPT', 'REJECT', 'FAULT'],
    timeoutMs: 0,          // no timeout: vision fails loudly instead of hanging
    enter: function () { Machine.allOff(); },
    exit: function () { /* nothing to release */ }
  },
  ACCEPT: {
    next: ['COMPLETE', 'FAULT'],
    timeoutMs: function () { return CONFIG.completeDwellMs + CONFIG.formingTimeoutMs; },
    enter: function () { Machine.moveTo('outTray'); },
    exit: function () { /* nothing to release */ }
  },
  REJECT: {
    next: ['COMPLETE', 'FAULT'],
    timeoutMs: function () { return CONFIG.completeDwellMs + CONFIG.formingTimeoutMs; },
    enter: function () { Machine.moveTo('rejectTray'); },
    exit: function () { /* nothing to release */ }
  },
  COMPLETE: {
    next: ['IDLE', 'INITIALIZING'],
    timeoutMs: function () { return CONFIG.completeDwellMs; },
    enter: function () { Machine.allOff(); },
    exit: function () { /* nothing to release */ }
  },
  FAULT: {
    next: ['IDLE'],        // ONLY reachable through reset()
    timeoutMs: 0,          // FAULT never times out — it waits for a human
    enter: function () { Machine.allOff(); },
    exit: function () { /* nothing to release */ }
  }
};

const Simulation = (function () {
  'use strict';

  /* ==================================================================
   * MACHINE STATE — owned by this file and nowhere else.
   * ================================================================== */
  let state = 'IDLE';
  let mode = 'IDLE';                 // IDLE | RUNNING | FAULT | ESTOP
  let stateElapsedMs = 0;            // how long we have been in this state
  let requiresReset = false;
  let result = null;                 // null | 'PASS' | 'REJECT'
  let inspection = { length: null, width: null, thickness: null, shapeOK: null, reasons: [] };
  let fault = null;                  // { code, message, stateAtFault, timestamp }
  let cycleCount = 0;
  let cycleStartedAt = 0;
  let events = [];                   // ring buffer for the HMI log
  let running = false;               // is the tick timer active?
  let timerId = null;

  // Per-cycle scratch flags used by FORMING / ACCEPT / REJECT / COMPLETE
  const cycle = { dwellDone: false, resultStored: false, specimenAtVision: false, counted: false };

  // The batch of finished specimens (traceability, kept across resets)
  const batch = [];

  /* ==================================================================
   * LOGGING  (workflow Section 12 — stable, greppable tags)
   * These messages come from the machine logic. They are NOT hard-coded
   * console text in index.html.
   * ================================================================== */
  function log(tag, message) {
    const line = '[' + tag + '] ' + message;
    events.push(line);
    if (events.length > CONFIG.maxEventLog) { events.shift(); }
    if (typeof console !== 'undefined') { console.log(line); }
  }

  /* ==================================================================
   * stateTimeLeftMs() — how much time this state has left before its
   * timeout fires. Every "wait until..." exit condition needs one, so no
   * state can hang forever (workflow Section 4).
   * ================================================================== */
  function stateTimeLeftMs() {
    const def = STATES[state];
    if (!def || typeof def.timeoutMs !== 'function') { return Infinity; }
    const limit = def.timeoutMs();
    if (limit <= 0) { return Infinity; }
    return limit - stateElapsedMs;
  }

  /* ==================================================================
   * changeState(next) — the ONLY way the machine moves between states.
   *
   * It refuses illegal transitions. If a state claims it may only go to
   * ['ALIGNING','FAULT'] and something asks for 'CUTTING', the request is
   * rejected and logged rather than obeyed. This guard is what makes the
   * state table in the documentation real rather than decorative.
   * ================================================================== */
  function changeState(next) {
    if (next === state) { return false; }

    const def = STATES[state];
    const allowed = (def && def.next) ? def.next : [];

    if (allowed.indexOf(next) === -1) {
      log('FAULT', 'ILLEGAL TRANSITION BLOCKED: ' + state + ' -> ' + next);
      return false;
    }

    if (def && typeof def.exit === 'function') { def.exit(); }

    state = next;
    stateElapsedMs = 0;

    if (STATES[next] && typeof STATES[next].enter === 'function') {
      STATES[next].enter();
    }

    log('STATE', next);
    return true;
  }

  /* ==================================================================
   * raiseFault(code) — the machine's only way to fail.
   *
   * The order matters and follows workflow Section 10 / 11 exactly:
   *   1. stop the actuators        2. freeze the sensors
   *   3. store the reason          4. move to FAULT
   * A fault NEVER continues by itself — reset() is required.
   * ================================================================== */
  function raiseFault(code) {
    if (state === 'FAULT' && fault) { return; }   // already stopped

    const message = FAULT_CODES[code] || 'Unknown fault';

    // 1. stop every actuator immediately (safe stop)
    Machine.allOff();

    // 2. freeze the sensors so the last values remain as evidence
    Sensors.freeze();

    // 3. store the reason together with where it happened
    fault = {
      code: code,
      message: message,
      stateAtFault: state,
      timestamp: Date.now()
    };

    requiresReset = true;

    log('FAULT', message);

    // 4. enter FAULT. changeState() is bypassed deliberately here because
    //    an emergency stop / fault must be able to stop us from ANY state.
    if (state !== 'FAULT') {
      const def = STATES[state];
      if (def && typeof def.exit === 'function') { def.exit(); }
      state = 'FAULT';
      stateElapsedMs = 0;
      STATES.FAULT.enter();
      log('STATE', 'FAULT');
    }

    mode = Sensors.isEstopLatched() ? 'ESTOP' : 'FAULT';
    stopTimer();
  }

  /* ==================================================================
   * SCAN FOR FAULTS  — runs BEFORE any state action (workflow Section 4).
   *
   * This is the "safety beats progress" rule. Three checks apply in EVERY
   * state, including IDLE and COMPLETE:
   *   1. emergency stop latched      -> ESTOP_ACTIVE
   *   2. safety interlock not OK     -> INTERLOCK_OPEN
   *   3. a sensor is dead            -> SENSOR_FAILURE
   * ================================================================== */
  function scanForFaults() {
    if (state === 'FAULT') { return; }

    if (Sensors.isEstopLatched()) { raiseFault('ESTOP_ACTIVE'); return; }

    // The interlock is only meaningful while the machine is running or has
    // finished a cycle. A powered-on machine sitting in IDLE with the guard
    // open is not a fault — it simply cannot be started (checked in start()).
    if (state !== 'IDLE' && !Sensors.isSafe()) {
      raiseFault('INTERLOCK_OPEN');
      return;
    }

    const test = Sensors.selfTest();
    if (!test.ok) {
      raiseFault('SENSOR_FAILURE');
      return;
    }
  }

  /* ==================================================================
   * EVALUATE EXIT CONDITIONS — one block per state.
   *
   * Every block answers the question from the state table in
   * docs/machine-workflow.md Section 7: "what must be true to leave?"
   * If the answer never becomes true, the state's timeout fires instead,
   * so no state can hang forever.
   * ================================================================== */
  function evaluateExit() {
    switch (state) {

      case 'INITIALIZING':
        // Exit: safety OK + all self-tests healthy + axis homed
        if (Sensors.selfTest().ok && Sensors.isSafe() && Machine.specimenAtTarget()) {
          changeState('CABLE_DETECTED');
        }
        break;

      case 'CABLE_DETECTED':
        // Exit: cable stably detected
        if (Sensors.isCableDetected()) {
          log('SENSOR', 'CABLE DETECTED');
          changeState('FEEDING');
        }
        break;

      case 'FEEDING': {
        // Cable lost during feeding -> immediate fault, no timeout.
        if (!Sensors.isCableDetected()) { raiseFault('CABLE_LOST'); break; }

        // Two independent sensors must agree about where the cable is.
        const drift = Math.abs(Sensors.encoderMm() - Sensors.position());
        if (drift > CONFIG.encoderToleranceMm) {
          raiseFault('ENCODER_MISMATCH');
          break;
        }
        // Exit: feed target reached AND encoder agrees with position
        if (Sensors.positionReached() && drift <= CONFIG.encoderToleranceMm) {
          changeState('ALIGNING');
        }
        break;
      }

      case 'ALIGNING':
        if (!Sensors.isCableDetected()) { raiseFault('CABLE_LOST'); break; }
        // Exit: alignment sensor stable AND cable still there
        if (Sensors.isAligned()) {
          log('SENSOR', 'ALIGNMENT OK');
          changeState('MEASURING');
        }
        break;

      case 'MEASURING': {
        // Measure once, then judge. This is a decision, so it lives here.
        if (!Sensors.isAligned()) { raiseFault('MISALIGNMENT'); break; }

        const measured = Sensors.measuredCutLengthMm();
        const deviation = Math.abs(measured - CONFIG.targetSpecimenLengthMm);

        if (deviation > CONFIG.lengthToleranceMm) {
          // Decision D2: no specimen exists yet, so this is a MACHINE fault,
          // not a REJECT. The machine could not achieve the commanded length.
          raiseFault('LENGTH_OUT_OF_TOLERANCE');
          break;
        }

        // The cut position sensor is the machine's PERMIT TO CUT.
        if (!Sensors.cutPositionReady()) { break; }   // keep waiting (timeout guards us)

        log('SENSOR', 'POSITION = ' + Sensors.position().toFixed(1));
        log('SENSOR', 'CUT POSITION READY');
        log('SENSOR', 'MEASURED LENGTH = ' + measured.toFixed(2) + ' mm');
        changeState('CUTTING');
        break;
      }

      case 'CUTTING':
        // Exit: the blade finished its stroke AND the cut was confirmed.
        if (Machine.cutterComplete()) {
          log('ACTUATOR', 'CUTTER OFF');
          log('SENSOR', 'CUT CONFIRMED');
          changeState('PREPARING');
        } else if (stateTimeLeftMs() <= 0) {
          raiseFault('CUTTING_FAILURE');
        }
        break;

      case 'PREPARING':
        // Exit: the Preparation Sensor confirms the work was really done
        if (Machine.preparationComplete() && Sensors.isPrepared()) {
          log('ACTUATOR', 'PREPARATION OFF');
          log('SENSOR', 'PREPARATION COMPLETE');
          changeState('FORMING');
        } else if (stateTimeLeftMs() <= 0) {
          raiseFault('PREPARATION_FAILURE');
        }
        break;

      case 'FORMING':
        // Leg 1: travel to the forming station, then clamp.
        // Leg 2: travel on to the vision station.
        if (!cycle.dwellDone) {
          if (Machine.specimenAtTarget()) {
            cycle.dwellDone = true;
            Machine.moveTo('vision');
            stateElapsedMs = 0;              // restart the timeout for leg 2
          }
        } else if (Machine.specimenAtTarget()) {
          cycle.specimenAtVision = true;
          changeState('INSPECTING');
        }
        break;

      case 'INSPECTING': {
        // The camera produces a verdict. WE decide what it means.
        const verdict = Sensors.runVision();
        const v = Sensors.visionData();

        inspection = {
          length: v.length, width: v.width, thickness: v.thickness,
          shapeOK: v.shapeOK, reasons: v.reasons.slice()
        };

        if (verdict === 'ERROR') {
          // Decision D3: the machine failed, it did not judge a bad product.
          raiseFault('VISION_FAILURE');
        } else if (verdict === 'PASS') {
          changeState('ACCEPT');
        } else {
          changeState('REJECT');
        }
        break;
      }

      case 'ACCEPT':
      case 'REJECT': {
        // Store the record first — traceability before anything else.
        if (!cycle.resultStored) {
          result = (state === 'ACCEPT') ? 'PASS' : 'REJECT';
          storeResultRecord();
          cycle.resultStored = true;
          log('INSPECTION', result);
          for (let i = 0; i < inspection.reasons.length; i++) {
            log('INSPECTION', 'REASON: ' + inspection.reasons[i]);
          }
        }
        // Exit: the specimen has been delivered to its tray
        if (cycle.resultStored && Machine.specimenAtTarget()) {
          changeState('COMPLETE');
        }
        break;
      }

      case 'COMPLETE':
        // Close the cycle — but EXACTLY ONCE. The COMPLETE state lasts for
        // several ticks, so the counter must be guarded, otherwise the
        // cycle would be counted once per tick instead of once per cycle.
        if (!cycle.counted) {
          cycleCount += 1;
          cycle.counted = true;
          log('STATE', 'Cycle ' + cycleCount + ' closed (' + result + ')');
        }
        Machine.allOff();
        mode = 'IDLE';
        if (stateTimeLeftMs() <= 0) { changeState('IDLE'); }
        break;

      case 'IDLE':
      case 'FAULT':
      default:
        // IDLE waits for start(). FAULT waits for a human reset().
        break;
    }
  }

  /* ==================================================================
   * storeResultRecord() — traceability.
   * A REJECT without its reason is worthless, which is one of the
   * problems this project exists to solve (workflow Section 16).
   * ================================================================== */
  function storeResultRecord() {
    batch.push({
      specimenId: 'SPEC-' + (batch.length + 1),
      cycle: cycleCount + 1,
      result: result,
      length: inspection.length,
      width: inspection.width,
      thickness: inspection.thickness,
      shapeOK: inspection.shapeOK,
      reasons: inspection.reasons.slice(),
      cutLengthMm: Sensors.measuredCutLengthMm(),
      timestamp: Date.now(),
      durationMs: Date.now() - cycleStartedAt
    });
  }

  /* ==================================================================
   * reportActuatorChanges() — log each ON/OFF exactly once.
   * machine.js records that a flag changed; this file decides it is
   * worth telling the operator about.
   * ================================================================== */
  const ACTUATOR_LABELS = {
    feedMotor: 'FEED MOTOR',
    feedRollers: 'FEED ROLLERS',
    cutter: 'CUTTER',
    preparation: 'PREPARATION',
    specimenMovement: 'SPECIMEN MOVEMENT'
  };

  function reportActuatorChanges() {
    for (const name in ACTUATOR_LABELS) {
      const flag = Machine.takeChanged(name);
      if (flag === true) { log('ACTUATOR', ACTUATOR_LABELS[name] + ' ON'); }
      else if (flag === false) { log('ACTUATOR', ACTUATOR_LABELS[name] + ' OFF'); }
    }
  }



  /* ==================================================================
   * world — physical facts that are NOT produced by an actuator.
   * The operator loads a cable; that is a fact about the world.
   * ================================================================== */
  const world = { cableLoaded: false };

  /* ==================================================================
   * buildWorld() — the plain description of physical reality this tick.
   *
   * This is the ONLY channel by which machine.js reaches sensors.js:
   * the brain collects the facts and hands them to the eyes. Neither
   * of those two files ever calls the other.
   * ================================================================== */
  function buildWorld() {
    return {
      cableLoaded: world.cableLoaded,
      positionMm: Machine.positionMm(),
      encoderMm: Machine.encoderPulses() / CONFIG.encoderPulsesPerMm,
      alignWorkMm: Machine.alignWorkMm(),
      preparationStrokeComplete: Machine.preparationComplete()
    };
  }

  /* ==================================================================
   * tick() — ONE step of the machine. This is the whole controller.
   *
   * The order is deliberate and matches workflow Section 4:
   *   0. advance physics   (machine.js moves whatever is switched on)
   *   1. read the sensors  (sensors.js reports the new reality)
   *   2. scan for faults   (SAFETY FIRST — before any new command)
   *   3. log actuator changes
   *   4. evaluate the exit (may cause a state transition)
   *
   * Step 0 exists because a controller must advance physics before the
   * sensors can read the result of that motion. The four documented steps
   * keep their relative order.
   * ================================================================== */
  function tick() {
    if (state === 'FAULT') {
      // A fault never continues by itself. We still refresh the sensors so
      // the HMI keeps showing WHERE the machine stopped (sensors.md 13).
      Sensors.update(buildWorld());
      return;
    }

    // 0. physics
    Machine.tick(CONFIG.simulationIntervalMs / 1000);
    stateElapsedMs += CONFIG.simulationIntervalMs;

    // 1. read the sensors
    Sensors.update(buildWorld());

    // 2. safety scan — this can end the tick early
    scanForFaults();
    if (state === 'FAULT') { return; }

    // 3. report what the muscles did
    reportActuatorChanges();

    // 4. decide whether this state is finished
    evaluateExit();

    // 5. a state that runs out of time is a fault. CUTTING and PREPARING
    //    check their own clock (for them a timeout means "the tool did not
    //    finish its stroke"), so handleStateTimeout skips them.
    if (state !== 'FAULT' && stateTimeLeftMs() <= 0) {
      handleStateTimeout();
    }
  }

  /* ==================================================================
   * handleStateTimeout() — the generic timeout for the states that do not
   * check their own clock. Maps each state to the right fault code.
   * ================================================================== */
  function handleStateTimeout() {
    switch (state) {
      case 'INITIALIZING':   raiseFault('HOMING_TIMEOUT');       break;
      case 'CABLE_DETECTED': raiseFault('CABLE_NOT_DETECTED');   break;
      case 'FEEDING':        raiseFault('FEED_TIMEOUT');         break;
      case 'ALIGNING':       raiseFault('MISALIGNMENT');         break;
      case 'FORMING':        raiseFault('SPECIMEN_NOT_PLACED');   break;
      case 'MEASURING':      raiseFault('SENSOR_FAILURE');       break; // cut-position sensor stuck
      case 'ACCEPT':
      case 'REJECT':
      case 'COMPLETE':       raiseFault('SENSOR_FAILURE');       break;
      default:               break;   // IDLE / INSPECTING: no timeout by design
    }
  }


  /* ==================================================================
   * machineData — THE PUBLIC CONTRACT (workflow Section 16)
   *
   * This object is the ONLY output of the Person 1 module. Person 2's
   * HMI reads this and nothing else. It is rebuilt from scratch on every
   * call so the HMI can never hold a stale or half-updated reference.
   * ================================================================== */
  function machineData() {
    const s = Sensors.read();
    return {
      state: state,
      mode: mode,
      position: Number(Sensors.position().toFixed(2)),
      speed: Machine.speed(),
      encoder: Sensors.encoderCounts(),
      cycleCount: cycleCount,
      requiresReset: requiresReset,
      estopLatched: Sensors.isEstopLatched(),
      sensors: {
        cableDetected: s.cableDetected,
        positionReached: Sensors.positionReached(),
        aligned: s.aligned,
        cutPositionReady: s.cutPositionReady,
        preparationComplete: s.preparationComplete,
        safetyOK: s.safetyOK,
        visionResult: s.visionResult
      },
      actuators: Machine.actuators(),
      inspection: {
        length: inspection.length,
        width: inspection.width,
        thickness: inspection.thickness,
        shapeOK: inspection.shapeOK,
        reasons: inspection.reasons.slice()
      },
      result: result,
      fault: fault,
      events: events.slice()
    };
  }

  /* ==================================================================
   * OPERATOR COMMANDS
   * These are the buttons on the machine. Each one is a COMMAND, not a
   * decision — what happens next is decided by tick().
   * ================================================================== */

  /* ---- start() : begin a new cycle from IDLE ---------------------- */
  function start() {
    if (state === 'FAULT') {
      log('FAULT', 'START REFUSED: the machine is in FAULT and needs a reset');
      return false;
    }
    if (requiresReset) {
      log('FAULT', 'START REFUSED: requiresReset is set');
      return false;
    }
    if (state !== 'IDLE') { return false; }

    // A start with the guard open is a fault, exactly as the IDLE row of
    // the state table says (workflow Section 7.1).
    if (!Sensors.isSafe()) {
      raiseFault('INTERLOCK_OPEN');
      return false;
    }
    if (Sensors.isEstopLatched()) {
      raiseFault('ESTOP_ACTIVE');
      return false;
    }

    resetCycleScratch();
    cycleStartedAt = Date.now();

    log('START', 'Standard=IS10810(sim) Material=PVC(sim) Type=INSULATION Qty=1');
    log('SAFETY', 'OK');

    mode = 'RUNNING';
    startTimer();
    changeState('INITIALIZING');
    return true;
  }

  /* ---- loadCable() / unloadCable() : world facts ------------------- */
  function loadCable()   { world.cableLoaded = true;  log('SENSOR', 'Cable placed in the loading station'); }
  function unloadCable() { world.cableLoaded = false; log('SENSOR', 'Cable removed from the loading station'); }

  /* ==================================================================
   * TIMER — the heartbeat that calls tick().
   * index.html only starts this; it never calls tick() itself.
   * ================================================================== */
  function startTimer() {
    if (timerId !== null) { return; }
    running = true;
    if (typeof setInterval === 'function') {
      timerId = setInterval(tick, CONFIG.simulationIntervalMs);
    }
  }

  function stopTimer() {
    if (timerId !== null && typeof clearInterval === 'function') {
      clearInterval(timerId);
    }
    timerId = null;
    running = false;
  }


  /* ==================================================================
   * emergencyStop() — workflow Section 10, step by step.
   *
   * This is an OVERRIDE. It may be called in any state, at any tick, and
   * it takes priority over everything else, including a running cycle.
   * ================================================================== */
  function emergencyStop() {
    Sensors.triggerEmergencyStop();   // S7 latches the E-stop

    Machine.allOff();                 // 1-5. every actuator OFF, immediately

    Sensors.freeze();                 // freeze the readings as evidence
    requiresReset = true;             // a human must reset before another run
    mode = 'ESTOP';

    raiseFault('ESTOP_ACTIVE');       // stores the reason and enters FAULT

    log('ACTUATOR', 'FEED MOTOR OFF');
    stopTimer();
    return true;
  }

  /* ---- releaseEmergencyStop() : turn the mushroom button back -------- */
  function releaseEmergencyStop() {
    Sensors.releaseEmergencyStop();
    log('SAFETY', 'Emergency stop released (the fault is still latched)');
  }

  /* ==================================================================
   * reset() — the ONLY way out of FAULT. Workflow Section 11.
   *
   * The steps run in the documented order and ABORT if the root cause
   * still exists. Note what is cleared and what is KEPT: cycleCount and
   * the batch record are history, not machine state.
   * ================================================================== */
  function reset() {
    // 1. pre-conditions
    if (Sensors.isEstopLatched()) {
      log('FAULT', FAULT_CODES.RESET_BLOCKED + ' (emergency stop still latched)');
      return false;
    }
    if (!Sensors.isSafe()) {
      log('FAULT', FAULT_CODES.RESET_BLOCKED + ' (safety interlock still open)');
      return false;
    }

    // 2. stop everything, even if something was mid-action
    Machine.allOff();

    // 3. clear the fault latches
    fault = null;
    requiresReset = false;

    // 4. clear the inspection result
    inspection = { length: null, width: null, thickness: null, shapeOK: null, reasons: [] };
    result = null;

    // 5. zero the machine and the sensors
    Machine.resetMotion();
    Sensors.unfreeze();
    Sensors.reset();

    // 6. clear per-cycle timers and counters
    resetCycleScratch();
    stateElapsedMs = 0;

    // 7. back to IDLE. cycleCount and the batch are KEPT on purpose.
    state = 'IDLE';
    mode = 'IDLE';
    STATES.IDLE.enter();

    log('RESET', 'Machine reset to IDLE');
    return true;
  }

  /* ==================================================================
   * resetCycleScratch() — the per-cycle flags. These are cleared at the
   * start of every cycle and by reset(), but NOT the history.
   * ================================================================== */
  function resetCycleScratch() {
    cycle.dwellDone = false;
    cycle.resultStored = false;
    cycle.specimenAtVision = false;
    cycle.counted = false;
  }

  /* ==================================================================
   * INIT — hand the configuration to the other two modules.
   *
   * THIS IS THE ONLY PLACE THE THREE MODULES ARE CONNECTED.
   * sensors.js and machine.js never call each other; the brain wires them
   * together and passes the facts between them.
   * ================================================================== */
  function init() {
    Sensors.init(CONFIG);
    Machine.init(CONFIG);
    log('RESET', 'Machine initialised to IDLE');
    return true;
  }

  /* ==================================================================
   * PUBLIC API
   * ================================================================== */
  return {
    // lifecycle
    init: init,
    machineData: machineData,
    tick: tick,

    // operator commands
    start: start,
    reset: reset,
    emergencyStop: emergencyStop,
    releaseEmergencyStop: releaseEmergencyStop,
    loadCable: loadCable,
    unloadCable: unloadCable,

    // timer
    startTimer: startTimer,
    stopTimer: stopTimer,
    isRunning: function () { return running; },

    // history / traceability
    batch: function () { return batch.slice(); },
    clearBatch: function () { batch.length = 0; },

    // configuration (read-only for the HMI)
    config: function () { return CONFIG; },

    // test hooks, delegated to sensors.js (docs/sensors.md Section 14)
    injectFault: function (what, value) {
      switch (what) {
        case 'CABLE_LOST':        Sensors.injectCableLost(); break;
        case 'ENCODER_DRIFT':     Sensors.setEncoderDrift(value); break;
        case 'LENGTH_OFFSET':     Sensors.setMeasuredLengthOffset(value); break;
        case 'VISION_ERROR':      Sensors.setVisionError(true); break;
        case 'SENSOR_FAILURE':    Sensors.injectFailure(value || 'position'); break;
        case 'CUT_POSITION_STUCK':Sensors.setCutPositionForce(value === undefined ? false : value); break;
        case 'OUT_OF_RANGE':      Sensors.setSpecimenOutOfRange(value || 'thickness'); break;
        case 'INTERLOCK_OPEN':    Sensors.setInterlockOpen(true); break;
        default: log('FAULT', 'Unknown fault injection: ' + what);
      }
    },
    clearInjectedFaults: function () {
      Sensors.clearCableLost();
      Sensors.setEncoderDrift(0);
      Sensors.setMeasuredLengthOffset(0);
      Sensors.setVisionError(false);
      Sensors.setSpecimenOutOfRange(null);
      Sensors.setCutPositionForce(null);
      Sensors.setInterlockOpen(false);
    },

    // state readers (for the test UI)
    getState: function () { return state; },
    getMode: function () { return mode; },
    getEvents: function () { return events.slice(); }
  };
})();

/* Public browser reference for the HMI integration adapter. */
if (typeof window !== 'undefined') {
  window.Simulation = Simulation;
}

/* Wire the three modules together as soon as this file loads. */
Sensors.init(MACHINE_CONFIG);
Machine.init(MACHINE_CONFIG);

/* Node.js compatibility so the simulation can be tested headlessly. */
if (typeof module !== 'undefined' && module.exports) { module.exports = Simulation; }

