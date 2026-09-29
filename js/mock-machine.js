/* ==========================================================================
 * CablePrep HMI — mock-machine.js
 * Phase 2 : MOCK MACHINE DATA PROVIDER (temporary development infrastructure)
 *
 * ARCHITECTURE
 *   CURRENT  : this mock provider simulates a full preparation cycle and
 *              pushes NORMALIZED data through
 *                  CablePrep.App.updateMachineData(data)
 *   FUTURE   : Person 1's real machine simulation replaces this provider
 *              through the same normalized contract (see machine-data.js).
 *              The HMI does not change.
 *
 * RULES
 *   - NO UI code in this file (rendering belongs to app.js and friends).
 *   - One simulation loop only (start/stop/reset are leak-safe).
 *   - Emits on every tick AND on every state transition.
 *   - Values are DEMO values — NOT verified IS 10810 requirements.
 * ========================================================================== */
(function () {
    'use strict';

    window.CablePrep = window.CablePrep || {};

    var TICK_MS = 100; /* simulation tick (real ms per update) */

    /* Demo state durations in ms (multiplied by timeScale). */
    var DURATIONS = {
        INITIALIZING: 1500,
        CABLE_DETECTED: 1200,
        FEEDING: 3000,
        ALIGNING: 1600,
        MEASURING: 1800,
        CUTTING: 1500,
        PREPARING: 1500,
        FORMING: 1400,
        INSPECTING: 2000,
        ACCEPT: 1500,
        REJECT: 1500,
        COMPLETE: 1800
    };

    /* Normal run order (ACCEPT and REJECT are alternatives). */
    var FLOW = [
        'INITIALIZING', 'CABLE_DETECTED', 'FEEDING', 'ALIGNING', 'MEASURING',
        'CUTTING', 'PREPARING', 'FORMING', 'INSPECTING', 'ACCEPT_REJECT',
        'COMPLETE'
    ];

    /* Demo fault catalogue (Phase 2 fault demonstration). */
    var FAULTS = {
        misalign: {
            code: 'MISALIGN',
            message: 'Alignment fault',
            condition: 'Alignment verification failed',
            station: 'align'
        },
        safety: {
            code: 'SAFETY_INTERLOCK',
            message: 'Safety interlock',
            condition: 'Safety circuit opened',
            station: null
        },
        sensor: {
            code: 'SENSOR',
            message: 'Sensor failure',
            condition: 'Position sensor feedback lost',
            station: 'measure'
        }
    };

    /* ------------------------------------------------------------------
     * Internal machine state (single source of truth for the mock)
     * ------------------------------------------------------------------ */
    var m = {
        state: 'IDLE',
        running: false,
        mode: 'AUTOMATIC',

        stateElapsed: 0,   /* ms elapsed inside the current state */
        elapsedTotal: 0,   /* ms elapsed in the current run */

        position: 0,       /* mm  (demo) */
        speed: 0,          /* mm/s (demo) */
        encoder: 0,        /* pulses (demo: 5 pulses/mm) */

        cableDetected: false,
        aligned: null,     /* null = not checked */
        safetyOK: true,
        cutPositionReady: false,
        preparationReady: false,

        measurements: null,     /* { length, width, thickness } (demo) */
        pendingResult: null,    /* decision taken at MEASURING, shown later */
        result: null,           /* ACCEPT | REJECT | null */
        resultParameter: null,

        fault: null,
        faultStepIndex: -1,
        faultStepProgress: 0,

        targetLength: 100,  /* feed target from configuration (demo mm) */
        quantity: 4,        /* specimens per batch from configuration */
        batchIndex: 4,      /* -> "CP-004" */
        specimenIndex: 1,
        runCompleted: false,

        timeScale: 1,             /* dev/test knob: speed multiplier —
                                     >1 fast-forwards the demo (tests use 3) */
        intervalId: null,
        activeIntervals: 0,       /* diagnostics: must never exceed 1 */
        intervalsCreated: 0
    };

    /* ------------------------------------------------------------------
     * Small helpers
     * ------------------------------------------------------------------ */
    function pad(n, width) {
        var s = String(n);
        while (s.length < width) { s = '0' + s; }
        return s;
    }

    function rnd(min, max) { return min + Math.random() * (max - min); }

    function round1(v) { return Math.round(v * 10) / 10; }

    function round2(v) { return Math.round(v * 100) / 100; }

    function frac() {
        var dur = DURATIONS[m.state];
        if (!dur) { return 0; }
        return Math.min(1, m.stateElapsed / dur);
    }

    function flowIndex(state) {
        if (state === 'ACCEPT' || state === 'REJECT') { return 9; }
        return FLOW.indexOf(state);
    }

    /* Reads the HMI configuration (quantity / feed length / operating mode)
       so the mock machine is driven by the Test Configuration screen. */
    function readConfig() {
        var app = window.CablePrep && window.CablePrep.App;
        if (!app || typeof app.getConfiguration !== 'function') { return; }
        var cfg = app.getConfiguration();
        if (cfg.quantity) { m.quantity = cfg.quantity; }
        m.targetLength = cfg.length > 0 ? cfg.length : 100; /* demo default */
        if (cfg.mode) { m.mode = cfg.mode; }
    }

    /* Demo measurements — PLACEHOLDER values, NOT verified IS 10810 data. */
    function generateMeasurements() {
        var reject = m.pendingResult === 'REJECT';
        return {
            length: round2(m.targetLength + rnd(-0.4, 0.4)),
            width: round2(10 + rnd(-0.15, 0.15)),
            thickness: reject ? 2.4 : round2(1.5 + rnd(-0.04, 0.04))
        };
    }

    /* ------------------------------------------------------------------
     * Simulation loop (single, leak-safe lifecycle)
     * ------------------------------------------------------------------ */
    function ensureLoop() {
        if (m.intervalId !== null) { return; }
        m.intervalId = window.setInterval(tick, TICK_MS);
        m.activeIntervals += 1;
        m.intervalsCreated += 1;
    }

    function stopLoop() {
        if (m.intervalId === null) { return; }
        window.clearInterval(m.intervalId);
        m.intervalId = null;
        m.activeIntervals -= 1;
    }

    /* Pushes the normalized snapshot into the HMI (the only output path). */
    function emit() {
        var app = window.CablePrep && window.CablePrep.App;
        var md = window.CablePrep && window.CablePrep.MachineData;
        if (!app || typeof app.updateMachineData !== 'function' || !md) { return; }
        app.updateMachineData(md.normalize(buildRaw()));
    }

    /* ------------------------------------------------------------------
     * State transitions
     * ------------------------------------------------------------------ */
    function onEnter(state, prev) {
        /* End of a completed run: clear per-run sensors, KEEP the result
           on screen until the next START or a manual RESET. */
        if (prev === 'COMPLETE' && state === 'IDLE') {
            m.runCompleted = true;
            m.running = false;
            stopLoop();
            m.position = 0;
            m.speed = 0;
            m.encoder = 0;
            m.cableDetected = false;
            m.aligned = null;
            m.cutPositionReady = false;
            m.preparationReady = false;
            return;
        }

        switch (state) {
        case 'CABLE_DETECTED':
            m.cableDetected = true;
            break;
        case 'ALIGNING':
            m.aligned = false;           /* alignment is being verified */
            break;
        case 'MEASURING':
            m.measurements = generateMeasurements();
            break;
        case 'CUTTING':
            m.cutPositionReady = true;
            break;
        case 'PREPARING':
            m.preparationReady = true;
            break;
        default:
            break;
        }
    }

    function setState(next) {
        var prev = m.state;
        m.state = next;
        m.stateElapsed = 0;
        onEnter(next, prev);
    }

    /* Finalizes values of the state we are leaving (used by manual steps). */
    function finalizeCurrent() {
        if (m.state === 'FEEDING') {
            m.position = m.targetLength;
            m.encoder = Math.round(m.position * 5);
            m.speed = 0;
        }
    }

    function decideResult() {
        if (m.forceNextResult) {
            m.result = m.forceNextResult;
            m.forceNextResult = null;
        } else {
            /* Demo acceptance rate (NOT a quality claim). */
            m.result = Math.random() < 0.8 ? 'ACCEPT' : 'REJECT';
        }
        m.resultParameter = (m.result === 'REJECT') ? 'thickness' : null;
        m.pendingResult = m.result;
        return m.result;
    }

    function nextStateOf(state) {
        if (state === 'IDLE') { return 'INITIALIZING'; }
        if (state === 'INSPECTING') { return decideResult(); }
        if (state === 'ACCEPT' || state === 'REJECT') { return 'COMPLETE'; }
        if (state === 'COMPLETE') { return 'IDLE'; }
        var i = FLOW.indexOf(state);
        if (i === -1) { return 'IDLE'; }
        var next = FLOW[i + 1];
        return next === 'ACCEPT_REJECT' ? 'ACCEPT' : (next || 'IDLE');
    }

    function advance() {
        finalizeCurrent();
        setState(nextStateOf(m.state));
        emit();
    }

    /* Simulation tick: advances time, derives sensor values, emits. */
    function tick() {
        if (!m.running) { return; }

        var dt = TICK_MS * m.timeScale;
        m.stateElapsed += dt;
        m.elapsedTotal += dt;

        var f = frac();

        /* Live sensor derivation (demo values) */
        if (m.state === 'FEEDING') {
            m.position = round1(m.targetLength * f);
            m.speed = f < 1 ? 100 : 0;
        } else {
            m.speed = 0;
        }
        m.encoder = Math.round(m.position * 5);

        if (m.state === 'ALIGNING' && m.aligned === false && f >= 0.3) {
            m.aligned = true;   /* alignment verified while aligning */
        }

        /* Auto-advance only in AUTOMATIC mode; MANUAL waits for START. */
        var dur = DURATIONS[m.state];
        if (dur && m.stateElapsed >= dur) {
            if (m.mode === 'AUTOMATIC') {
                advance();      /* advance() emits */
                return;
            }
            m.stateElapsed = dur; /* clamp and wait for a manual step */
        }

        emit();
    }

    /* Builds the raw snapshot; machine-data.js turns it into the contract. */
    function buildRaw() {
        var md = window.CablePrep.MachineData;
        var stepIdx = (m.state === 'FAULT')
            ? m.faultStepIndex
            : (m.state === 'IDLE' ? -1 : md.STATE_STEP[m.state]);

        var stepProg = (m.state === 'FAULT')
            ? m.faultStepProgress
            : (stepIdx === -1 ? 0 : Math.round(frac() * 100));

        var progress = 0;
        if (stepIdx >= 0) {
            progress = Math.round(((stepIdx + stepProg / 100) / 10) * 1000) / 10;
        }

        var systemStatus = 'READY';
        if (m.state === 'FAULT') {
            systemStatus = 'FAULT';
        } else if (m.state === 'IDLE') {
            systemStatus = 'READY';
        } else if (!m.running) {
            systemStatus = 'STOPPED';
        } else {
            systemStatus = 'RUNNING';
        }

        return {
            state: m.state,
            running: m.running,

            position: m.position,
            speed: m.speed,
            encoder: m.encoder,

            cableDetected: m.cableDetected,
            aligned: m.aligned,
            safetyOK: m.safetyOK,
            cutPositionReady: m.cutPositionReady,
            preparationReady: m.preparationReady,

            length: m.measurements ? m.measurements.length : null,
            width: m.measurements ? m.measurements.width : null,
            thickness: m.measurements ? m.measurements.thickness : null,

            result: m.result,
            resultParameter: m.resultParameter,
            fault: m.fault,

            process: m.state,
            progress: progress,
            stepIndex: stepIdx,
            stepProgress: stepProg,
            station: (m.state === 'FAULT')
                ? (m.fault && m.fault.station ? m.fault.station : null)
                : (md.STATE_STATION[m.state] || null),
            cableFraction: m.targetLength > 0 ? Math.min(1, m.position / m.targetLength) : 0,
            elapsedMs: Math.round(m.elapsedTotal),
            batch: 'CP-' + pad(m.batchIndex, 3),
            specimen: pad(m.specimenIndex, 2) + ' / ' + pad(m.quantity, 2),
            mode: m.mode,
            systemStatus: systemStatus
        };
    }

    /* ------------------------------------------------------------------
     * Public API (the HMI talks to the machine only through this object)
     * ------------------------------------------------------------------ */
    var MockMachine = {
        /* START: begin a cycle / resume / (MANUAL) advance one step. */
        start: function () {
            if (m.state === 'FAULT') { return false; } /* RESET required */

            if (m.state === 'IDLE') {
                if (m.runCompleted) {
                    m.runCompleted = false;
                    m.specimenIndex += 1;              /* next specimen */
                    if (m.specimenIndex > m.quantity) {
                        m.specimenIndex = 1;
                        m.batchIndex += 1;             /* next batch */
                    }
                }
                /* Fresh run: clear the previous result display. */
                m.result = null;
                m.resultParameter = null;
                m.pendingResult = null;
                m.measurements = null;
                m.elapsedTotal = 0;
                m.stateElapsed = 0;
                readConfig();
                m.running = true;
                setState('INITIALIZING');
                ensureLoop();
                emit();
                return true;
            }

            m.running = true;
            ensureLoop();
            if (m.mode === 'MANUAL') {
                advance();     /* one controlled step per START */
            } else {
                emit();        /* AUTOMATIC: resume paused cycle */
            }
            return true;
        },

        /* STOP: pause the cycle safely (no state reset). */
        stop: function () {
            if (m.state === 'IDLE' || m.state === 'FAULT') {
                emit();
                return false;
            }
            m.running = false;
            m.speed = 0;
            stopLoop();
            emit();
            return true;
        },

        /* RESET: clear state, sensors, progress, result, fault and timers.
           Returns to IDLE without reloading the page. */
        reset: function () {
            stopLoop();
            m.state = 'IDLE';
            m.running = false;
            m.stateElapsed = 0;
            m.elapsedTotal = 0;
            m.position = 0;
            m.speed = 0;
            m.encoder = 0;
            m.cableDetected = false;
            m.aligned = null;
            m.safetyOK = true;
            m.cutPositionReady = false;
            m.preparationReady = false;
            m.measurements = null;
            m.pendingResult = null;
            m.result = null;
            m.resultParameter = null;
            m.fault = null;
            m.faultStepIndex = -1;
            m.faultStepProgress = 0;
            m.runCompleted = false;
            m.specimenIndex = 1;   /* back to the first specimen of the batch */
            emit();
            return true;
        },

        /* Demo fault injection (Phase 2 fault demonstration). */
        injectFault: function (type) {
            var def = FAULTS[type];
            if (!def || m.state === 'FAULT') { return false; }

            m.faultStepIndex = (m.state === 'IDLE')
                ? -1
                : (window.CablePrep.MachineData.STATE_STEP[m.state] || -1);
            m.faultStepProgress = Math.round(frac() * 100);

            m.fault = {
                code: def.code,
                message: def.message,
                condition: def.condition,
                station: def.station
            };
            if (type === 'misalign') { m.aligned = false; }
            if (type === 'safety') { m.safetyOK = false; }

            m.running = false;
            m.speed = 0;
            stopLoop();
            setState('FAULT');
            emit();
            return true;
        },

        setMode: function (mode) {
            m.mode = (mode === 'MANUAL') ? 'MANUAL' : 'AUTOMATIC';
        },

        getState: function () { return m.state; },

        /* Dev/test knobs (harmless in normal operation).
           setTimeScale: speed multiplier — 3 = 3x faster demo cycle. */
        setTimeScale: function (scale) {
            var s = Number(scale);
            m.timeScale = isFinite(s) ? Math.min(10, Math.max(0.05, s)) : 1;
        },
        setNextResult: function (result) {
            m.forceNextResult = (result === 'ACCEPT' || result === 'REJECT') ? result : null;
        },
        getDiagnostics: function () {
            return {
                state: m.state,
                running: m.running,
                mode: m.mode,
                loopActive: m.intervalId !== null,
                activeIntervals: m.activeIntervals,
                intervalsCreated: m.intervalsCreated,
                timeScale: m.timeScale
            };
        }
    };

    /* Register with the HMI (CURRENT provider; Person 1 replaces this). */
    function init() {
        var app = window.CablePrep && window.CablePrep.App;
        if (app && typeof app.registerMachine === 'function') {
            app.registerMachine(MockMachine);
        }
        emit();   /* initial idle snapshot (batch, specimen, sensors) */
    }

    window.CablePrep.MockMachine = MockMachine;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }



})();
