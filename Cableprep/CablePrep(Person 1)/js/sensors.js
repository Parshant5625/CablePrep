/* ==========================================================================
 * CablePrep  —  js/sensors.js
 * THE EYES OF THE VIRTUAL MACHINE
 * Owner: Person 1 — Engineering / Control
 * Design source of truth: docs/sensors.md (v0.1.1)
 * --------------------------------------------------------------------------
 * THE ONE RULE OF THIS FILE (docs/sensors.md Section 1):
 *   A sensor REPORTS. It never acts and never decides.
 *
 * This file MUST NOT:
 *   - change the machine state
 *   - turn an actuator ON or OFF
 *   - decide when to cut / feed / prepare
 *   - raise a machine fault
 *   - run the state machine
 *
 * It only holds values and updates them. simulation.js reads those values
 * and decides what happens next.
 * --------------------------------------------------------------------------
 * A sensor is a MIRROR, not a hand. machine.js moves the cable; this file
 * reports where the cable got to.
 * ========================================================================== */

const Sensors = (function () {
  'use strict';

  let cfg = null;   // MACHINE_CONFIG, handed in by simulation.js at init

  /* ------------------------------------------------------------------
   * INTERNAL STATE
   * `raw`    = what the sensor physically reads this tick
   * `stable` = the value the machine is ALLOWED to believe
   * The two differ for the three debounced sensors (docs/sensors.md 12.1)
   * ------------------------------------------------------------------ */
  const raw = {
    cableDetected: false,
    aligned: false,
    cutPositionReady: false,
    preparationComplete: false,
    safetyOK: true,
    visionResult: null
  };

  const stable = {
    cableDetected: false,
    aligned: false,
    preparationComplete: false
  };

  // Debounce counters — one per debounced sensor
  const debounce = { cable: 0, align: 0, prep: 0 };

  // S2 / S3 : the sensor's own copy of the measured values
  let positionMm = 0;
  let encoderPulses = 0;

  // S8 : vision results
  let vision = {
    length: null,
    width: null,
    thickness: null,
    shapeOK: null,
    reasons: []
  };

  // A sensor that has been electrically killed by a test hook
  const failed = {};

  // S7 : safety chain
  let interlockOpen = false;
  let estopLatched = false;

  // docs/sensors.md Section 13 — when frozen, values stop updating so the
  // HMI can still show WHERE the machine stopped. Never reset to zero.
  let frozen = false;

  /* ------------------------------------------------------------------
   * FAULT-INJECTION SWITCHES (docs/sensors.md Section 14)
   * These are TEST INPUTS ONLY. Normal operation never touches them,
   * and there is NO Math.random() anywhere in this project.
   * ------------------------------------------------------------------ */
  const inject = {
    cableLost: false,
    encoderDriftMm: 0,
    measuredLengthOffsetMm: 0,
    cutPositionForce: null,   // null = normal, true/false = force the reading
    visionError: false,
    outOfRangeProperty: null  // e.g. 'thickness' -> forces a REJECT
  };

  /* ------------------------------------------------------------------
   * init(config) — called once by simulation.js.
   * Stores the configuration and puts every sensor at its idle value.
   * ------------------------------------------------------------------ */
  function init(config) {
    cfg = config;
    reset();
  }

  /* ------------------------------------------------------------------
   * reset() — returns every sensor to its defined IDLE value
   * (docs/sensors.md Section 13 "Reset"; workflow Section 11 step 5)
   * ------------------------------------------------------------------ */
  function reset() {
    raw.cableDetected = false;
    raw.aligned = false;
    raw.cutPositionReady = false;
    raw.preparationComplete = false;
    raw.safetyOK = true;
    raw.visionResult = null;

    stable.cableDetected = false;
    stable.aligned = false;
    stable.preparationComplete = false;

    debounce.cable = 0;
    debounce.align = 0;
    debounce.prep = 0;

    positionMm = 0;
    encoderPulses = 0;

    vision = { length: null, width: null, thickness: null, shapeOK: null, reasons: [] };

    for (const key in failed) { delete failed[key]; }

    interlockOpen = false;
    estopLatched = false;
    frozen = false;

    inject.cableLost = false;
    inject.encoderDriftMm = 0;
    inject.measuredLengthOffsetMm = 0;
    inject.cutPositionForce = null;
    inject.visionError = false;
    inject.outOfRangeProperty = null;
  }

  /* ==================================================================
   * computeSafetyOK() — the ONE place the safety chain is evaluated.
   *
   * It is a function, not a stored flag, so that a safety CHECK can never
   * act on a stale cached reading. `raw.safetyOK` is still maintained for
   * display, but isSafe() computes live (docs/sensors.md Section 9).
   *
   * Fail-safe: a dead safety sensor counts as UNSAFE. The machine must
   * never assume safety just because it cannot prove the danger is absent.
   * ================================================================== */
  function computeSafetyOK() {
    if (failed.safetyOK) { return false; }
    return !interlockOpen && !estopLatched;
  }

  /* ==================================================================
   * DEBOUNCE HELPER  (docs/sensors.md Section 12.1 / 12.2)
   *
   * A real sensor next to a vibrating cutter will give a wrong answer for
   * one tick now and then. If the machine believed that single tick it could
   * cut a bent cable. So `stable` only changes after the raw reading has
   * repeated `requiredTicks` times.
   *
   * counterKey : which debounce counter to use ('cable' | 'align' | 'prep')
   * ================================================================== */
  // Maps a debounce counter name to the sensor value it protects.
  // (The three debounced sensors are exactly those in docs/sensors.md 12.1)
  const DEBOUNCED = {
    cable: 'cableDetected',
    align: 'aligned',
    prep: 'preparationComplete'
  };

  function debounceUpdate(counterKey, requiredTicks) {
    const sensorName = DEBOUNCED[counterKey];

    if (raw[sensorName]) {
      debounce[counterKey] += 1;   // reading repeats -> counter climbs
    } else {
      debounce[counterKey] = 0;    // reading broke -> counter falls to zero
    }

    // The machine may only believe the reading once it has repeated enough times.
    stable[sensorName] = (debounce[counterKey] >= requiredTicks);
  }

  /* ==================================================================
   * SELF-TEST  (workflow Section 7.1 — INITIALIZING)
   *
   * Checks that every sensor can actually report. A dead sensor must be
   * caught BEFORE the machine starts moving, not halfway through cutting.
   * Returns { ok: true } or { ok: false, sensor: 'name' }.
   * ================================================================== */
  function selfTest() {
    for (const name in failed) {
      if (failed[name]) { return { ok: false, sensor: name }; }
    }
    return { ok: true };
  }

  /* ==================================================================
   * update(world)  — the per-tick refresh. Called by simulation.js ONLY.
   *
   * `world` is a plain object describing physical reality this tick.
   * Sensors READ it. They never write to it and never act on it.
   * ================================================================== */
  function update(world) {
    if (!cfg) { return; }
    if (frozen) { return; }   // docs/sensors.md 13: keep the last values in FAULT

    /* ---- S7 : SAFETY INTERLOCK -------------------------------------
     * Evaluated first because it is the root of trust.
     * The cached value is for DISPLAY only; decisions call isSafe(),
     * which recomputes live (see computeSafetyOK above).            */
    raw.safetyOK = computeSafetyOK();

    /* ---- S1 : CABLE DETECTION --------------------------------------
     * Reads "is a cable physically in the sensing zone?".
     * inject.cableLost models the cable dropping out of the grippers.  */
    if (!failed.cableDetected) {
      raw.cableDetected = (world.cableLoaded === true) && !inject.cableLost;
    }
    debounceUpdate('cable', cfg.cableDetectStableTicks);

    /* ---- S2 : POSITION SENSOR --------------------------------------
     * machine.js moved the cable. We REPORT where it got to, and we
     * check the reading is physically possible (docs/sensors.md S2).  */
    if (!failed.position) {
      const reported = Number(world.positionMm);
      if (!Number.isFinite(reported) || reported < 0 || reported > cfg.maxTravelMm) {
        failed.position = true;          // implausible reading = dead sensor
      } else {
        positionMm = reported;
      }
    }

    /* ---- S3 : ENCODER -----------------------------------------------
     * Independent cross-check of S2. inject.encoderDriftMm makes it
     * disagree, which is how ENCODER_MISMATCH is tested.              */
    if (!failed.encoder) {
      const drifted = world.encoderMm + inject.encoderDriftMm;
      if (!Number.isFinite(drifted) || drifted < -cfg.encoderToleranceMm) {
        failed.encoder = true;
      } else {
        encoderPulses = Math.round(drifted * cfg.encoderPulsesPerMm);
      }
    }

    /* ---- S4 : ALIGNMENT SENSOR -------------------------------------
     * The Feed Rollers in align mode do corrective jogs. The cable
     * becomes straight once enough total correction has been applied.
     * This is a FIXED deterministic pattern, never random.           */
    if (!failed.aligned) {
      const corrected = world.alignWorkMm >= cfg.alignJogMm * cfg.alignJogStepsToStraight;
      raw.aligned = corrected === true;
    }
    debounceUpdate('align', cfg.alignStableTicks);

    /* ---- S5 : CUT POSITION SENSOR ----------------------------------
     * Derived from S2: is the cable under the cutter?
     * THIS IS THE MACHINE'S "PERMIT TO CUT".                          */
    if (failed.cutPosition) {
      raw.cutPositionReady = false;
    } else if (inject.cutPositionForce !== null) {
      raw.cutPositionReady = inject.cutPositionForce;
    } else {
      raw.cutPositionReady = Math.abs(positionMm - cfg.cuttingPositionMm) <= cfg.cutPositionToleranceMm;
    }

    /* ---- S6 : PREPARATION SENSOR -----------------------------------
     * Confirms the stripping/peeling stroke actually finished.
     * It does NOT become true merely because time passed — the
     * mechanism must report the stroke complete.                     */
    if (!failed.preparationComplete) {
      raw.preparationComplete = world.preparationStrokeComplete === true;
    }
    debounceUpdate('prep', cfg.preparationStableTicks);
  }

  // Rounds to 2 decimal places so readings read like real measurements.
  function round2(n) { return Math.round(n * 100) / 100; }

  /* ==================================================================
   * S8 : VISION SYSTEM  (docs/sensors.md Section 10)
   *
   * Produces the DETERMINISTIC "perfect specimen" values, then compares
   * each one against its configured acceptable band.
   *
   *   every value inside its band  -> "PASS"
   *   any value outside its band   -> "REJECT" + a reason string
   *   camera error / no reading    -> "ERROR"   (a MACHINE fault, not a reject)
   *
   * NOTE THE DISTINCTION: "REJECT" means the machine worked correctly and
   * correctly found a bad specimen. "ERROR" means the machine itself failed.
   * ================================================================== */
  function runVision() {
    // A dead camera, or a camera that cannot see anything = ERROR, not REJECT.
    if (failed.vision || inject.visionError) {
      vision = { length: null, width: null, thickness: null, shapeOK: null, reasons: [] };
      raw.visionResult = 'ERROR';
      return raw.visionResult;
    }

    const good = cfg.goodMeasurement;
    const range = cfg.visionRange;

    vision = {
      length: good.length,
      width: good.width,
      thickness: good.thickness,
      shapeOK: true,
      reasons: []
    };

    // An injected out-of-range value forces a REJECT (test hook only).
    // We place the value just BELOW the minimum band edge, which produces a
    // realistic reading such as 1.42 mm rather than an absurd one like 0.
    if (inject.outOfRangeProperty) {
      const prop = inject.outOfRangeProperty;
      const band = range[prop];
      if (band) { vision[prop] = round2(band.min - 0.08); }
    }

    // Compare every measured property against its band.
    for (const prop of ['length', 'width', 'thickness']) {
      const band = range[prop];
      if (!band) { continue; }
      const value = vision[prop];
      if (value < band.min || value > band.max) {
        const label = prop.charAt(0).toUpperCase() + prop.slice(1);
        vision.reasons.push(
          label + ' outside configured range (' + round2(value) + ' mm, allowed ' +
          band.min.toFixed(2) + '-' + band.max.toFixed(2) + ' mm)'
        );
      }
    }

    if (!vision.shapeOK) {
      vision.reasons.push('Shape outside configured profile');
    }

    raw.visionResult = (vision.reasons.length === 0) ? 'PASS' : 'REJECT';
    return raw.visionResult;
  }

  /* ==================================================================
   * READ API  — what simulation.js is allowed to look at.
   * Same shape as machineData.sensors (workflow Section 16).
   * ================================================================== */
  function read() {
    return {
      cableDetected: stable.cableDetected,
      aligned: stable.aligned,
      cutPositionReady: raw.cutPositionReady,
      preparationComplete: stable.preparationComplete,
      safetyOK: raw.safetyOK,
      visionResult: raw.visionResult
    };
  }

  // Individual readers, used by the state machine.
  function position()         { return positionMm; }
  function encoderMm()        { return encoderPulses / cfg.encoderPulsesPerMm; }
  function encoderCounts()    { return encoderPulses; }
  function isAligned()        { return stable.aligned; }
  function isCableDetected()  { return stable.cableDetected; }
  function isPrepared()       { return stable.preparationComplete; }
  function cutPositionReady() { return raw.cutPositionReady; }
  function isSafe()           { return computeSafetyOK(); }   // live, never stale
  function isEstopLatched()   { return estopLatched; }
  function visionData()       { return vision; }
  function visionResult()     { return raw.visionResult; }

  // The length that will be cut, including any injected measurement error.
  function measuredCutLengthMm() {
    return positionMm + inject.measuredLengthOffsetMm;
  }

  /* ==================================================================
   * DERIVED VALUE — `positionReached`
   * docs/sensors.md 11.1: this is a COMPARISON of a sensor value against
   * configuration, so it is not a separate sensor.
   * ================================================================== */
  function positionReached() {
    return positionMm >= cfg.feedDistanceMm;
  }
  /* ==================================================================
   * FAULT-INJECTION TEST HOOKS  (docs/sensors.md Section 14)
   * Test inputs only. They may be called from a test panel or a test
   * script — never from normal machine logic.
   * ================================================================== */
  function injectFailure(sensorName)          { failed[sensorName] = true; }
  function setInterlockOpen(open)             { interlockOpen = open === true; }
  function triggerEmergencyStop()             { estopLatched = true; }
  function releaseEmergencyStop()             { estopLatched = false; }
  function injectCableLost()                  { inject.cableLost = true; }
  function clearCableLost()                   { inject.cableLost = false; }
  function setEncoderDrift(mm)                { inject.encoderDriftMm = Number(mm) || 0; }
  function setMeasuredLengthOffset(mm)        { inject.measuredLengthOffsetMm = Number(mm) || 0; }
  function setVisionError(on)                 { inject.visionError = on === true; }
  function setSpecimenOutOfRange(property)    { inject.outOfRangeProperty = property || null; }
  function setCutPositionForce(value)         { inject.cutPositionForce = value; }

  // docs/sensors.md Section 13 — freeze every value (used on entering FAULT)
  function freeze()   { frozen = true; }
  function unfreeze() { frozen = false; }
  function isFrozen() { return frozen; }

  /* ==================================================================
   * PUBLIC API
   * ================================================================== */
  return {
    // lifecycle
    init: init,
    reset: reset,
    update: update,
    selfTest: selfTest,

    // reads
    read: read,
    position: position,
    encoderMm: encoderMm,
    encoderCounts: encoderCounts,
    isAligned: isAligned,
    isCableDetected: isCableDetected,
    isPrepared: isPrepared,
    cutPositionReady: cutPositionReady,
    isSafe: isSafe,
    isEstopLatched: isEstopLatched,
    visionData: visionData,
    visionResult: visionResult,
    measuredCutLengthMm: measuredCutLengthMm,
    positionReached: positionReached,
    runVision: runVision,

    // test hooks
    injectFailure: injectFailure,
    setInterlockOpen: setInterlockOpen,
    triggerEmergencyStop: triggerEmergencyStop,
    releaseEmergencyStop: releaseEmergencyStop,
    injectCableLost: injectCableLost,
    clearCableLost: clearCableLost,
    setEncoderDrift: setEncoderDrift,
    setMeasuredLengthOffset: setMeasuredLengthOffset,
    setVisionError: setVisionError,
    setSpecimenOutOfRange: setSpecimenOutOfRange,
    setCutPositionForce: setCutPositionForce,

    // freeze
    freeze: freeze,
    unfreeze: unfreeze,
    isFrozen: isFrozen
  };
})();

/* Node.js compatibility so the simulation can be tested headlessly.
   This adds nothing to the browser behaviour. */
if (typeof module !== 'undefined' && module.exports) { module.exports = Sensors; }

