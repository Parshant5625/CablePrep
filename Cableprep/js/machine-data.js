/* ==========================================================================
 * CablePrep HMI — machine-data.js
 * Phase 2 : NORMALIZED MACHINE DATA CONTRACT + ADAPTER
 *
 * ARCHITECTURE
 *   CURRENT  : js/mock-machine.js produces raw snapshots
 *              -> this adapter normalizes them
 *              -> CablePrep.App.updateMachineData(data) renders the HMI
 *   FUTURE   : Person 1's machine simulation (wrapped by a thin adapter)
 *              produces the SAME normalized object
 *              -> CablePrep.App.updateMachineData(data)
 *              -> the HMI does not need to change.
 *
 * NORMALIZED CONTRACT
 *   {
 *     state:   "FEEDING",      // IDLE | INITIALIZING | CABLE_DETECTED | FEEDING |
 *                              // ALIGNING | MEASURING | CUTTING | PREPARING |
 *                              // FORMING | INSPECTING | ACCEPT | REJECT |
 *                              // COMPLETE | FAULT
 *     running: true,           // process is actively ticking
 *     position: 150,           // mm          speed: 100 (mm/s)
 *     encoder: 750,            // pulses
 *     cableDetected: true,
 *     aligned: true,           // true | false | null (= not checked yet)
 *     safetyOK: true,
 *     cutPositionReady: false,
 *     preparationReady: false,
 *     length: 100, width: 10, thickness: 1.5,   // measured; null until measured
 *     result: null,            // "ACCEPT" | "REJECT" | null
 *     resultParameter: null,   // parameter that failed on REJECT (optional)
 *     fault: null,             // { code, message, condition, station } | null
 *     // HMI display fields (produced by the provider):
 *     process, progress (0..100), stepIndex (-1..9), stepLabel,
 *     stepProgress (0..100), station, cableFraction (0..1), elapsedMs,
 *     batch, specimen, mode, systemStatus
 *   }
 *
 * NOTE: all numeric values are DEMO / PLACEHOLDER values.
 *       They are NOT verified IS 10810 requirements.
 * ========================================================================== */
(function () {
    'use strict';

    window.CablePrep = window.CablePrep || {};

    var STATES = [
        'IDLE', 'INITIALIZING', 'CABLE_DETECTED', 'FEEDING', 'ALIGNING',
        'MEASURING', 'CUTTING', 'PREPARING', 'FORMING', 'INSPECTING',
        'ACCEPT', 'REJECT', 'COMPLETE', 'FAULT'
    ];

    /* The 10 process steps displayed by the HMI progress component. */
    var STEPS = [
        { label: 'Initialize',   state: 'INITIALIZING' },
        { label: 'Detect Cable', state: 'CABLE_DETECTED' },
        { label: 'Feed',         state: 'FEEDING' },
        { label: 'Align',        state: 'ALIGNING' },
        { label: 'Measure',      state: 'MEASURING' },
        { label: 'Cut',          state: 'CUTTING' },
        { label: 'Prepare',      state: 'PREPARING' },
        { label: 'Form',         state: 'FORMING' },
        { label: 'Inspect',      state: 'INSPECTING' },
        { label: 'Result',       state: 'ACCEPT' }  /* ACCEPT / REJECT / COMPLETE */
    ];

    /* Machine state -> step index (-1 = no active step). */
    var STATE_STEP = {
        IDLE: -1, INITIALIZING: 0, CABLE_DETECTED: 1, FEEDING: 2,
        ALIGNING: 3, MEASURING: 4, CUTTING: 5, PREPARING: 6,
        FORMING: 7, INSPECTING: 8, ACCEPT: 9, REJECT: 9,
        COMPLETE: 9, FAULT: -1 /* replaced by the frozen step on fault */
    };

    /* Machine state -> visualization station id. */
    var STATE_STATION = {
        IDLE: null, INITIALIZING: 'input', CABLE_DETECTED: 'input',
        FEEDING: 'feed', ALIGNING: 'align', MEASURING: 'measure',
        CUTTING: 'cut', PREPARING: 'prepare', FORMING: 'form',
        INSPECTING: 'inspect', ACCEPT: 'output', REJECT: 'output',
        COMPLETE: 'output', FAULT: null
    };

    function toNumber(value, fallback) {
        var n = Number(value);
        return isFinite(n) ? n : fallback;
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    /* Derives a best-effort in-step fraction when the provider did not send
       stepProgress (used only outside faults, e.g. legacy Phase 1 data). */
    function fracFromState(state, raw) {
        if (state === 'IDLE' || state === 'COMPLETE') { return 0; }
        var f = toNumber(raw.cableFraction, NaN);
        if (state === 'FEEDING' && isFinite(f)) {
            return clamp(f * 100, 0, 100);
        }
        return 0;
    }

    /* Normalizes any provider snapshot into the contract above.
       Missing/invalid fields fall back to safe defaults, so even a partial
       Phase-1 style object { state: 'FEEDING' } is accepted. */
    function normalize(raw) {
        raw = raw || {};

        var state = String(raw.state || 'IDLE').toUpperCase();
        if (STATES.indexOf(state) === -1) {
            state = 'IDLE';
        }

        var fault = null;
        if (raw.fault && typeof raw.fault === 'object') {
            fault = {
                code: String(raw.fault.code || 'FAULT'),
                message: String(raw.fault.message || 'Machine fault'),
                condition: String(raw.fault.condition || ''),
                station: raw.fault.station || null
            };
        }

        /* Step index: faults freeze the step where they occurred. */
        var stepIndex;
        if (state === 'FAULT') {
            stepIndex = (typeof raw.stepIndex === 'number')
                ? clamp(Math.round(raw.stepIndex), -1, STEPS.length - 1)
                : -1;
        } else {
            stepIndex = (typeof STATE_STEP[state] === 'number') ? STATE_STEP[state] : -1;
        }

        var station = (state === 'FAULT' && fault && fault.station)
            ? fault.station
            : (STATE_STATION[state] || null);

        var result = (raw.result === 'ACCEPT' || raw.result === 'REJECT') ? raw.result : null;

        function measured(v) {
            return (v === null || typeof v === 'undefined') ? null : toNumber(v, null);
        }

        /* Progress: use the provider's value when present, otherwise derive
           it from the step index so the HMI always receives a consistent 0..100. */
        function progressValue(idx, st, input) {
            if (input.progress !== null && typeof input.progress !== 'undefined') {
                return clamp(toNumber(input.progress, 0), 0, 100);
            }
            if (idx >= 0) {
                return clamp(((idx + stepProgressValue(st, input) / 100) / STEPS.length) * 100, 0, 100);
            }
            return 0;
        }

        /* In-step fraction: frozen on FAULT, provided value otherwise, and a
           best-effort derivation (cable fraction while FEEDING) for legacy
           partial data such as the Phase 1 { state } smoke test. */
        function stepProgressValue(st, input) {
            if (st === 'FAULT' && input.stepProgress !== null && typeof input.stepProgress !== 'undefined') {
                return clamp(toNumber(input.stepProgress, 0), 0, 100);
            }
            if (input.stepProgress === null || typeof input.stepProgress === 'undefined') {
                return fracFromState(st, input);
            }
            return clamp(toNumber(input.stepProgress, 0), 0, 100);
        }

        return {
            state: state,
            running: Boolean(raw.running),

            position: clamp(toNumber(raw.position, 0), 0, 100000),
            speed: clamp(toNumber(raw.speed, 0), 0, 100000),
            encoder: Math.max(0, Math.round(toNumber(raw.encoder, 0))),

            cableDetected: Boolean(raw.cableDetected),
            aligned: (raw.aligned === null || typeof raw.aligned === 'undefined')
                ? null
                : Boolean(raw.aligned),
            safetyOK: (typeof raw.safetyOK === 'undefined') ? true : Boolean(raw.safetyOK),

            cutPositionReady: Boolean(raw.cutPositionReady),
            preparationReady: Boolean(raw.preparationReady),

            length: measured(raw.length),
            width: measured(raw.width),
            thickness: measured(raw.thickness),

            result: result,
            resultParameter: raw.resultParameter ? String(raw.resultParameter) : null,
            fault: fault,

            /* HMI display fields */
            process: String(raw.process || state),
            progress: progressValue(stepIndex, state, raw),
            stepIndex: stepIndex,
            stepLabel: String(raw.stepLabel || (stepIndex >= 0 ? STEPS[stepIndex].label : '—')),
            stepProgress: stepProgressValue(state, raw),
            station: station,
            cableFraction: clamp(toNumber(raw.cableFraction, 0), 0, 1),
            elapsedMs: Math.max(0, toNumber(raw.elapsedMs, 0)),
            batch: String(raw.batch || '—'),
            specimen: String(raw.specimen || '—'),
            mode: raw.mode === 'MANUAL' ? 'MANUAL' : 'AUTOMATIC',
            systemStatus: String(raw.systemStatus || 'READY').toUpperCase()
        };
    }

    window.CablePrep.MachineData = {
        normalize: normalize,
        STATES: STATES,
        STEPS: STEPS,
        STATE_STEP: STATE_STEP,
        STATE_STATION: STATE_STATION
    };
})();

