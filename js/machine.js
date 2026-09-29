/* ==========================================================================
 * CablePrep  —  js/machine.js
 * THE MUSCLES OF THE VIRTUAL MACHINE
 * Owner: Person 1 — Engineering / Control
 * Design source of truth: docs/actuators.md (v0.1)
 * --------------------------------------------------------------------------
 * THE ONE RULE OF THIS FILE (docs/actuators.md Section 1.1):
 *   An actuator OBeys. It never decides.
 *
 * This file MUST NOT:
 *   - decide which machine state should run
 *   - read sensors to make decisions
 *   - start a cycle
 *   - decide when to cut / feed / prepare
 *   - raise faults
 *   - transition between states
 *
 * The ENTIRE public API is three functions:
 *     set(actuatorName, on, mode)   the ONLY way an actuator changes state
 *     allOff()                      force every actuator OFF
 *     tick(dt)                      advance the motion of whatever is ON
 *
 * Advancing position is NOT a decision — it is the muscle's job.
 * Deciding WHEN to stop is the brain's job, and that is simulation.js.
 * ========================================================================== */

const Machine = (function () {
  'use strict';

  let cfg = null;   // MACHINE_CONFIG, handed in by simulation.js at init

  /* ------------------------------------------------------------------
   * ACTUATOR FLAGS — the five actuators of docs/actuators.md Section 2.
   * These are the ONLY things this file is allowed to switch on and off.
   * ------------------------------------------------------------------ */
  const A = {
    feedMotor:        { on: false, label: 'FEED MOTOR' },
    feedRollers:      { on: false, label: 'FEED ROLLERS', mode: 'feed' },
    cutter:           { on: false, label: 'CUTTER' },
    preparation:      { on: false, label: 'PREPARATION' },
    specimenMovement: { on: false, label: 'SPECIMEN MOVEMENT', targetMm: 0, atTarget: false }
  };

  /* ------------------------------------------------------------------
   * MOTION MODEL — where things physically ARE right now.
   * The sensors report these values; this file is what changes them.
   * ------------------------------------------------------------------ */
  const motion = {
    positionMm: 0,        // FEED axis  (A1 + A2)
    encoderPulses: 0,     // FEED axis, counted independently
    axisPositionMm: 0,    // SPECIMEN axis (A5)
    alignWorkMm: 0,       // cumulative straightening work done in align mode
    clampMs: 0            // dwell timer used when clamping a specimen
  };

  // Timers for the two timed strokes (cutter, preparation mechanism)
  const stroke = {
    cutterElapsedMs: 0,
    cutterComplete: false,
    preparationElapsedMs: 0,
    preparationComplete: false
  };

  // Counters that are HISTORY, not machine state — reset() must KEEP these
  const history = { cutCount: 0 };

  // Who last changed each actuator, so simulation.js can log ON/OFF once
  // instead of on every tick.
  const lastLogged = {};

  /* ==================================================================
   * init(config)
   * ================================================================== */
  function init(config) {
    cfg = config;
    resetMotion();
  }

  /* ==================================================================
   * resetMotion() — returns the machine to its physical idle.
   * NOTE: cutCount is deliberately NOT cleared. It is traceability
   * history, not machine state (docs/actuators.md A3 "During reset").
   * ================================================================== */
  function resetMotion() {
    for (const name in A) {
      A[name].on = false;
      if (name === 'feedRollers') { A[name].mode = 'feed'; }
      if (name === 'specimenMovement') { A[name].targetMm = 0; A[name].atTarget = false; }
    }

    motion.positionMm = 0;
    motion.encoderPulses = 0;
    motion.axisPositionMm = 0;
    motion.alignWorkMm = 0;
    motion.clampMs = 0;

    stroke.cutterElapsedMs = 0;
    stroke.cutterComplete = false;
    stroke.preparationElapsedMs = 0;
    stroke.preparationComplete = false;
  }

  /* ==================================================================
   * set(name, on, mode)  — THE ONLY WAY AN ACTUATOR CHANGES STATE
   *
   * on   : true / false
   * mode : optional. Used by feedRollers ('feed' | 'align') and by
   *        specimenMovement (the station it is travelling to).
   *
   * This function performs NO checking of its own. simulation.js has
   * already decided that this command is legal — for example, that the
   * cut position sensor permits the blade to move.
   * ================================================================== */
  function set(name, on, mode) {
    const act = A[name];
    if (!act) { return false; }

    const nextOn = on === true;
    const changed = (act.on !== nextOn);
    act.on = nextOn;

    if (name === 'feedRollers' && mode) { act.mode = mode; }
    if (name === 'specimenMovement' && typeof mode === 'number') {
      act.targetMm = mode;
      act.atTarget = false;
    }

    if (changed) { lastLogged[name] = nextOn; }
    return changed;
  }

  /* ==================================================================
   * allOff()  — forces every actuator OFF. Used by COMPLETE, FAULT,
   * reset(), and the safety interlock. No ramp, no delay.
   * ================================================================== */
  function allOff() {
    for (const name in A) {
      if (A[name].on) { lastLogged[name] = false; }
      A[name].on = false;
      if (name === 'feedRollers') { A[name].mode = 'feed'; }
    }
  }

  /* ==================================================================
   * tick(dtSeconds) — advance the motion of everything that is ON.
   *
   * This is PHYSICS, not decision-making. Each block below says
   * "while this muscle is energised, this is how the machine moves".
   * Nothing here decides whether the movement SHOULD continue —
   * simulation.js decides that by calling set(name, false).
   * ================================================================== */
  function tick(dtSeconds) {
    const dtMs = dtSeconds * 1000;

    /* ---- A1 + A2 : THE FEED AXIS -----------------------------------
     * Physical law of this machine: the cable only moves when the
     * motor is driving AND the rollers are gripping.
     * Motor ON + rollers OFF  =  SLIP  (the cable does not move).
     * This is how we reproduce the commonest real feeding fault with
     * no extra flag and no randomness.
     * -------------------------------------------------------------- */
    if (A.feedMotor.on && A.feedRollers.on) {
      const mmThisTick = cfg.feedSpeedMmPerSec * dtSeconds;
      motion.positionMm += mmThisTick;
      motion.encoderPulses += Math.round(mmThisTick * cfg.encoderPulsesPerMm);

      // Never travel past the physical end of the axis.
      if (motion.positionMm > cfg.maxTravelMm) {
        motion.positionMm = cfg.maxTravelMm;
      }
    }

    /* ---- A2 : ALIGNMENT MODE ---------------------------------------
     * In align mode the rollers are no longer feeding. They apply
     * corrective jogs that straighten the cable. The jogs are a FIXED
     * deterministic pattern — never random — so a demo can be trusted.
     * The jogs are corrective, so the FEED position does not change.
     * -------------------------------------------------------------- */
    if (A.feedRollers.on && A.feedRollers.mode === 'align') {
      motion.alignWorkMm += cfg.alignJogMm;   // straightening work accumulates
    }

    /* ---- A3 : THE CUTTER --------------------------------------------
     * A blade stroke is TIME LIMITED. The blade retracts by itself when
     * the stroke is finished — that is a physical limit of the tool,
     * not a decision. simulation.js then checks cutterComplete().
     * -------------------------------------------------------------- */
    if (A.cutter.on) {
      stroke.cutterElapsedMs += dtMs;
      if (stroke.cutterElapsedMs >= cfg.cutterStrokeMs) {
        stroke.cutterElapsedMs = cfg.cutterStrokeMs;
        stroke.cutterComplete = true;
        A.cutter.on = false;               // blade has retracted
        lastLogged.cutter = false;
        history.cutCount += 1;
      }
    }

    /* ---- A4 : THE PREPARATION MECHANISM ----------------------------
     * Same idea: a stripping stroke runs for a fixed time and stops.
     * It does NOT decide that preparation succeeded — the Preparation
     * Sensor confirms that, and simulation.js judges it.
     * -------------------------------------------------------------- */
    if (A.preparation.on) {
      stroke.preparationElapsedMs += dtMs;
      if (stroke.preparationElapsedMs >= cfg.preparationDurationMs) {
        stroke.preparationElapsedMs = cfg.preparationDurationMs;
        stroke.preparationComplete = true;
        A.preparation.on = false;
        lastLogged.preparation = false;
      }
    }

    /* ---- A5 : THE SPECIMEN AXIS ------------------------------------
     * Moves towards its commanded station and stops on arrival.
     * `atTarget` is what simulation.js uses to detect arrival.
     * -------------------------------------------------------------- */
    if (A.specimenMovement.on) {
      const target = A.specimenMovement.targetMm;
      const step = cfg.specimenSpeedMmPerSec * dtSeconds;
      const remaining = target - motion.axisPositionMm;

      if (Math.abs(remaining) <= step) {
        motion.axisPositionMm = target;     // arrived
        A.specimenMovement.on = false;
        A.specimenMovement.atTarget = true;
        lastLogged.specimenMovement = false;
      } else {
        motion.axisPositionMm += Math.sign(remaining) * step;
      }
    }
  }
  /* ==================================================================
   * READERS — what simulation.js is allowed to look at.
   * These report; they never change anything.
   * ================================================================== */
  function actuators() {
    return {
      feedMotor: A.feedMotor.on,
      feedRollers: A.feedRollers.on,
      cutter: A.cutter.on,
      preparation: A.preparation.on,
      specimenMovement: A.specimenMovement.on
    };
  }

  function isOn(name)       { return A[name] ? A[name].on : false; }
  function mode(name)       { return A[name] ? A[name].mode : null; }
  function positionMm()     { return motion.positionMm; }
  function encoderPulses()  { return motion.encoderPulses; }
  function axisPositionMm() { return motion.axisPositionMm; }
  function alignWorkMm()    { return motion.alignWorkMm; }

  // Speed is a report of what the feed axis is doing right now.
  // It is 0 unless BOTH the motor and the rollers are engaged.
  function speed() {
    return (A.feedMotor.on && A.feedRollers.on) ? cfg.feedSpeedMmPerSec : 0;
  }

  function cutterComplete()      { return stroke.cutterComplete; }
  function cutterElapsedMs()     { return stroke.cutterElapsedMs; }
  function preparationComplete() { return stroke.preparationComplete; }
  function specimenAtTarget()    { return A.specimenMovement.atTarget; }
  function cutCount()            { return history.cutCount; }

  // Consume a "changed" flag so simulation.js logs each ON/OFF exactly once
  // instead of on every single tick.
  function takeChanged(name) {
    const key = lastLogged[name];
    lastLogged[name] = undefined;
    return key;
  }

  /* ==================================================================
   * STATION HELPERS
   * The specimen axis travels between NAMED stations. simulation.js
   * passes the station NAME, never a raw number, so the machine layout
   * stays in one place (MACHINE_CONFIG) instead of being scattered
   * through the state machine as magic numbers.
   * ================================================================== */
  function stationPosition(stationName) {
    return cfg.stationPositions[stationName];
  }

  function moveTo(stationName) {
    const target = stationPosition(stationName);
    if (typeof target === 'number') {
      set('specimenMovement', true, target);
      return true;
    }
    return false;
  }

  /* ==================================================================
   * PUBLIC API
   * The three MUTATING functions are exactly those in
   * docs/actuators.md Section 1.3: set(), allOff(), tick().
   * ================================================================== */
  return {
    // the three commands
    set: set,
    allOff: allOff,
    tick: tick,

    // lifecycle
    init: init,
    resetMotion: resetMotion,

    // readers
    actuators: actuators,
    isOn: isOn,
    mode: mode,
    positionMm: positionMm,
    encoderPulses: encoderPulses,
    axisPositionMm: axisPositionMm,
    alignWorkMm: alignWorkMm,
    speed: speed,
    cutterComplete: cutterComplete,
    cutterElapsedMs: cutterElapsedMs,
    preparationComplete: preparationComplete,
    specimenAtTarget: specimenAtTarget,
    cutCount: cutCount,
    takeChanged: takeChanged,

    // specimen axis stations
    stationPosition: stationPosition,
    moveTo: moveTo
  };
})();

/* Node.js compatibility so the simulation can be tested headlessly. */
if (typeof module !== 'undefined' && module.exports) { module.exports = Machine; }

