/* ==========================================================================
 * CablePrep HMI — app.js
 * Phase 1 + Phase 2 : application shell + live HMI rendering
 *
 * Responsibilities:
 *   1. Screen navigation without page reloads
 *   2. Header date/time clock
 *   3. START / STOP / RESET bound to the registered machine provider
 *   4. Configuration form + CablePrep.App.getConfiguration()
 *   5. Rendering of normalized machine data on every screen
 *      (dashboard, monitor, sensors, process progress, visualization,
 *       fault banner, inspection, history hook)
 *   6. Public UI API -> window.CablePrep.App
 *
 * IMPORTANT (architecture):
 *   This file contains NO machine logic, state machine or sensor
 *   simulation. It only RENDERS normalized data received through
 *   CablePrep.App.updateMachineData(data).
 *   CURRENT : js/mock-machine.js is the data provider.
 *   FUTURE  : Person 1's simulation replaces the mock through an adapter
 *             (see js/machine-data.js) using the same function.
 * ========================================================================== */
(function () {
    'use strict';

    /* Shared namespace for all CablePrep UI modules. */
    window.CablePrep = window.CablePrep || {};

    var App = window.CablePrep.App = {};

    /* Status variants — must match the classes defined in css/hmi.css. */
    var STATUS_VARIANTS = {
        ready: true,
        running: true,
        stopped: true,
        warning: true,
        fault: true,
        pass: true,
        reject: true,
        waiting: true,
        idle: true,
        complete: true
    };

    /* Fallback badge styling for machine states without a dedicated variant
       (FEEDING, CUTTING... render 'running'; ACCEPT/REJECT render pass/reject). */
    var STATE_STYLE = {
        idle: 'idle',
        fault: 'fault',
        accept: 'pass',
        reject: 'reject',
        complete: 'complete',
        ready: 'ready'
    };

    function stateStyle(state) {
        return STATE_STYLE[String(state || '').toLowerCase()] || 'running';
    }

    /* Last normalized snapshot (used for run-completion detection). */
    var lastData = null;

    function formatElapsed(ms) {
        var tenths = Math.floor(ms / 100) % 10;
        var totalSec = Math.floor(ms / 1000);
        var sec = totalSec % 60;
        var min = Math.floor(totalSec / 60);
        return pad(min) + ':' + pad(sec) + '.' + tenths;
    }

    function formatDate(date) {
        return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' +
            pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
    }

    /* Sets a 0..100 percentage as an element's width. */
    function setWidth(id, pct) {
        var el = $(id);
        if (el) {
            var v = Math.max(0, Math.min(100, Number(pct) || 0));
            el.style.width = v + '%';
        }
    }

    /* ---------- small DOM helpers ---------- */
    function $(id) {
        return document.getElementById(id);
    }

    /* Sets text content; safe no-op when the element does not exist. */
    function setText(id, text) {
        var el = $(id);
        if (el) {
            el.textContent = text;
        }
    }

    /* Sets the status text and swaps the modifier class of a status element,
       e.g. status-badge--idle  ->  status-badge--running.
       `fallback` selects the style used for statuses without a dedicated
       variant (machine states such as FEEDING are shown as 'running'). */
    function applyStatus(id, baseClass, status, fallback) {
        var el = $(id);
        if (!el) {
            return;
        }
        var variant = String(status || '').toLowerCase();
        if (!STATUS_VARIANTS[variant]) {
            variant = fallback || 'waiting';
        }
        Object.keys(STATUS_VARIANTS).forEach(function (name) {
            el.classList.remove(baseClass + '--' + name);
        });
        el.classList.add(baseClass + '--' + variant);
        if (status) {
            el.textContent = String(status).toUpperCase();
        }
    }

    /* ---------- 1. Navigation (no page reload) ---------- */
    function initNavigation() {
        var items = document.querySelectorAll('.nav-item[data-screen]');
        var screens = document.querySelectorAll('.screen');

        Array.prototype.forEach.call(items, function (item) {
            item.addEventListener('click', function () {
                var target = item.getAttribute('data-screen');

                Array.prototype.forEach.call(items, function (other) {
                    var active = other === item;
                    other.classList.toggle('is-active', active);
                    if (active) {
                        other.setAttribute('aria-current', 'page');
                    } else {
                        other.removeAttribute('aria-current');
                    }
                });

                Array.prototype.forEach.call(screens, function (screen) {
                    screen.classList.toggle('is-active', screen.id === 'screen-' + target);
                });
            });
        });
    }

    /* ---------- 2. Header clock ---------- */
    function pad(n) {
        return n < 10 ? '0' + n : String(n);
    }

    function initClock() {
        var clock = $('headerClock');
        if (!clock) {
            return;
        }
        function tick() {
            var now = new Date();
            clock.textContent =
                now.getFullYear() + '-' +
                pad(now.getMonth() + 1) + '-' +
                pad(now.getDate()) + '  ' +
                pad(now.getHours()) + ':' +
                pad(now.getMinutes()) + ':' +
                pad(now.getSeconds());
        }
        tick();
        window.setInterval(tick, 1000);
    }

    /* ---------- 3. Dashboard controls (Phase 2: bound to the machine) ---------- */
    function initControls() {
        var buttons = document.querySelectorAll('.btn[data-action]');
        Array.prototype.forEach.call(buttons, function (btn) {
            btn.addEventListener('click', function () {
                var action = btn.getAttribute('data-action');
                var machine = App.machine;
                var manual = App.getConfiguration().mode === 'MANUAL';

                if (!machine) {
                    setText('controlFeedback', 'Machine provider not ready.');
                    return;
                }

                if (action === 'start') {
                    if (machine.getState && machine.getState() === 'FAULT') {
                        setText('controlFeedback', 'FAULT active — press RESET before starting.');
                        return;
                    }
                    machine.start();
                    setText('controlFeedback', manual
                        ? 'MANUAL — advanced one process step (prototype progression).'
                        : 'START — automatic cycle running.');
                } else if (action === 'stop') {
                    machine.stop();
                    setText('controlFeedback', 'STOP — machine stopped safely. START resumes, RESET clears.');
                } else if (action === 'reset') {
                    machine.reset();
                    setText('controlFeedback', 'RESET — machine reset to IDLE. Fault, sensors, progress and result cleared.');
                } else if (action === 'estop') {
                    if (typeof machine.emergencyStop === 'function') {
                        machine.emergencyStop();
                        setText('controlFeedback', 'EMERGENCY STOP — all machine motion stopped. Release E-stop, then RESET.');
                    }
                } else if (action === 'release-estop') {
                    if (typeof machine.releaseEmergencyStop === 'function') {
                        machine.releaseEmergencyStop();
                        setText('controlFeedback', 'E-stop released. Press RESET before restarting.');
                    }
                }
            });
        });
    }

    /* Fault demonstration buttons (Machine Monitor screen, Phase 2 demo). */
    function initFaultDemo() {
        var buttons = document.querySelectorAll('.btn[data-fault]');
        Array.prototype.forEach.call(buttons, function (btn) {
            btn.addEventListener('click', function () {
                if (App.machine && typeof App.machine.injectFault === 'function') {
                    App.machine.injectFault(btn.getAttribute('data-fault'));
                    setText('faultDemoFeedback',
                        'Fault injected: ' + btn.textContent.trim() + '. Press RESET to clear it.');
                }
            });
        });
    }

    /* ---------- 4. Configuration form ---------- */
    function initConfigForm() {
        var form = $('configForm');
        if (form) {
            form.addEventListener('submit', function (event) {
                event.preventDefault();
                setText('configFeedback',
                    'Configuration saved and applied to the live simulation. New batch settings apply from the next START.');
            });
        }

        /* Mirrors the selected mode into the status bar and dashboard tile.
           Pure UI mirroring — no machine behaviour involved. */
        try {
            var saved = JSON.parse(window.localStorage.getItem('cableprep.config.v1') || 'null');
            if (saved) {
                var map = { cfgStandard:'standard', cfgMaterial:'material', cfgSpecimenType:'specimenType',
                    cfgQuantity:'quantity', cfgMode:'mode', cfgLength:'length', cfgWidth:'width', cfgThickness:'thickness' };
                Object.keys(map).forEach(function (id) {
                    var el = $(id);
                    if (el && saved[map[id]] !== undefined && saved[map[id]] !== null) { el.value = saved[map[id]]; }
                });
            }
        } catch (e) {}

        var modeSelect = $('cfgMode');
        if (modeSelect) {
            modeSelect.addEventListener('change', function () {
                App.setMode(modeSelect.value);
                if (App.machine && typeof App.machine.setMode === 'function') {
                    App.machine.setMode(modeSelect.value);
                }
            });
        }
    }

    /* ---------- 5. Public setters (used by later phases) ---------- */
    App.setMode = function (mode) {
        var text = String(mode || 'AUTOMATIC').toUpperCase();
        setText('statusBarMode', text);
        setText('dashOperatingMode', text);
    };

    App.setSystemStatus = function (status) {
        var text = String(status || 'READY').toUpperCase();
        setText('headerStatusText', text);
        setText('statusBarSystemStatus', text);
        applyStatus('statusBarSystemStatus', 'status-text', text);
        applyStatus('dashSystemStatus', 'status-badge', text);

        var variant = text.toLowerCase();
        if (!STATUS_VARIANTS[variant]) {
            variant = (variant === 'ok') ? 'ready' : 'waiting';
        }
        var dot = $('headerStatusDot');
        if (dot) {
            dot.className = 'status-dot status-dot--' + variant;
        }
    };

    /* ---------- 6. Configuration provider (Phase 2) ----------
       Exposes the Test Configuration screen to the machine provider.
       All values are demo/placeholder values — no verified IS 10810 data. */
    App.getConfiguration = function () {
        var quantity = parseInt(inputValue('cfgQuantity'), 10);
        return {
            standard: selectValue('cfgStandard'),
            material: selectValue('cfgMaterial'),
            specimenType: selectValue('cfgSpecimenType'),
            quantity: (isFinite(quantity) && quantity > 0) ? quantity : 4,
            mode: selectValue('cfgMode') === 'MANUAL' ? 'MANUAL' : 'AUTOMATIC',
            length: numericValue('cfgLength'),
            width: numericValue('cfgWidth'),
            thickness: numericValue('cfgThickness')
        };
    };

    function selectValue(id) {
        var el = $(id);
        return el ? String(el.value || '') : '';
    }

    function inputValue(id) {
        var el = $(id);
        return el ? String(el.value || '') : '';
    }

    function numericValue(id) {
        var n = Number(inputValue(id));
        return isFinite(n) ? n : 0;
    }

    /* ---------- 7. Machine provider registration (Phase 2) ----------
       CURRENT : js/mock-machine.js registers itself here.
       FUTURE  : Person 1's simulation (behind an adapter) registers with
                 the same object shape: start / stop / reset / setMode.
       The HMI never touches provider internals — only this interface. */
    App.registerMachine = function (provider) {
        if (!provider || typeof provider.start !== 'function') {
            return false;
        }
        App.machine = provider;
        var config = App.getConfiguration();
        if (typeof provider.configure === 'function') {
            provider.configure(config);
        } else if (typeof provider.setMode === 'function') {
            provider.setMode(config.mode);
        }
        return true;
    };

    /* ---------- Machine data binding (integration point) ---------- */
    /**
     * Receives machine/process data produced by Person 1's simulation and
     * reflects it onto the existing HMI elements. This function NEVER
     * generates data itself — it is a pure UI binding.
     *
     * Recognised (optional) keys:
     *   state, process, progress, batch, specimen, mode, systemStatus,
     *   position (mm), speed (mm/s), encoder, cableDetected, aligned,
     *   cutPosition, motor, safetyOK
     *
     * Example (later phase):
     *   CablePrep.App.updateMachineData({
     *       state: 'FEEDING',
     *       position: 150,
     *       speed: 100,
     *       encoder: 750,
     *       cableDetected: true,
     *       aligned: true,
     *       safetyOK: true
     *   });
     */
    App.updateMachineData = function (data) {
        if (!data || typeof data !== 'object') {
            return;
        }

        /* Dashboard + monitor machine state */
        if (typeof data.state === 'string') {
            var style = stateStyle(data.state);
            applyStatus('dashMachineState', 'status-badge', data.state, style);
            applyStatus('monMachineState', 'status-badge', data.state, style);
            renderStepper(data);
            renderVisualization(data);
            renderFaultBanner(data);
        }
        if (typeof data.process === 'string') {
            applyStatus('dashCurrentProcess', 'status-badge', data.process, stateStyle(data.process));
        }
        if (typeof data.progress === 'number') {
            setText('dashProgressText', Math.round(data.progress) + '%');
            setWidth('dashProgressBar', data.progress);
        }
        if (typeof data.batch === 'string') {
            setText('dashCurrentBatch', data.batch);
        }
        if (typeof data.specimen === 'string') {
            setText('dashCurrentSpecimen', data.specimen);
        }
        if (data.mode) {
            App.setMode(data.mode);
        }
        if (data.systemStatus) {
            App.setSystemStatus(data.systemStatus);
        }

        /* Machine sensors (monitor + dashboard tiles) */
        if (typeof data.position !== 'undefined') {
            setText('monPosition', data.position + ' mm');
            setText('dashPosition', data.position + ' mm');
        }
        if (typeof data.speed !== 'undefined') {
            setText('monSpeed', data.speed + ' mm/s');
            setText('dashSpeed', data.speed + ' mm/s');
        }
        if (typeof data.encoder !== 'undefined') {
            setText('monEncoder', data.encoder + ' pulses');
        }
        if (typeof data.cableDetected !== 'undefined') {
            setText('monCableDetected', data.cableDetected ? 'YES' : 'NO');
        }
        if (typeof data.aligned !== 'undefined') {
            setText('monAlignment', data.aligned === null
                ? 'NOT CHECKED'
                : (data.aligned ? 'ALIGNED' : 'NOT ALIGNED'));
        }
        if (typeof data.cutPositionReady !== 'undefined') {
            setText('monCutPosition', data.cutPositionReady ? 'READY' : 'NOT READY');
        } else if (typeof data.cutPosition !== 'undefined') {
            setText('monCutPosition', String(data.cutPosition)); /* legacy key */
        }
        if (typeof data.preparationReady !== 'undefined') {
            setText('monPreparation', data.preparationReady ? 'READY' : 'NOT READY');
        }
        if (typeof data.motor !== 'undefined') {
            setText('monMotor', String(data.motor).toUpperCase());
        } else if (typeof data.running !== 'undefined') {
            /* motor status is derived when the provider does not send one */
            setText('monMotor', (data.running && data.state !== 'FAULT') ? 'RUNNING' : 'STOPPED');
        }
        if (typeof data.safetyOK !== 'undefined') {
            setText('monSafety', data.safetyOK ? 'OK' : 'FAULT');
            var safety = $('monSafety');
            if (safety) {
                safety.classList.toggle('monitor-value--ok', Boolean(data.safetyOK));
                safety.classList.toggle('monitor-value--fault', !data.safetyOK);
            }
            applyStatus('dashSafety', 'status-badge',
                data.safetyOK ? 'OK' : 'FAULT', data.safetyOK ? 'ready' : 'fault');
        }

        renderDashboardExtras(data);
        renderMonitorExtras(data);

        /* The inspection screen consumes the same normalized data. */
        var cp = window.CablePrep;
        if (cp.Inspection && typeof cp.Inspection.applyMachineData === 'function') {
            cp.Inspection.applyMachineData(data);
        }

        /* Basic Phase 2 hand-off: feed the history table once per completed
           run (richer records belong to a later phase). */
        if (data.state === 'COMPLETE' && data.result &&
                (!lastData || lastData.state !== 'COMPLETE') &&
                cp.History && typeof cp.History.addRun === 'function') {
            cp.History.addRun({
                batch: data.batch,
                specimens: 1,
                accepted: data.result === 'ACCEPT' ? 1 : 0,
                rejected: data.result === 'REJECT' ? 1 : 0,
                date: formatDate(new Date()),
                status: 'COMPLETE',
                lastResult: data.result
            });
        }

        if (cp.Reports && typeof cp.Reports.applyMachineData === 'function') {
            cp.Reports.applyMachineData(data);
        }

        lastData = data;
    };

    /* ---------- Phase 2 renderers (all consume normalized data) ---------- */

    /* 10-step process progress component: ✓ done, ● current, ○ pending */
    function renderStepper(data) {
        var items = document.querySelectorAll('#processStepper .step-item');
        var idx = (typeof data.stepIndex === 'number') ? data.stepIndex : -1;
        var faulted = Boolean(data.fault);

        Array.prototype.forEach.call(items, function (item) {
            var i = parseInt(item.getAttribute('data-step'), 10);
            var mark = item.querySelector('.step-mark');
            var done = i < idx;
            var current = i === idx;
            var faultHere = current && faulted;

            item.classList.toggle('is-done', done);
            item.classList.toggle('is-current', current && !faulted);
            item.classList.toggle('is-fault', faultHere);
            if (mark) {
                mark.textContent = faultHere ? '▲' : (done ? '✓' : (current ? '●' : '○'));
            }
        });
    }

    /* Conceptual machine visualization: active/done/fault stations + cable. */
    var STATION_ORDER = ['input', 'feed', 'align', 'measure', 'cut',
                         'prepare', 'form', 'inspect', 'output'];

    function renderVisualization(data) {
        var viz = $('machineViz');
        if (!viz) { return; }

        viz.classList.toggle('is-feeding', data.state === 'FEEDING');
        viz.classList.toggle('is-fault', Boolean(data.fault));

        var activeIdx = data.station ? STATION_ORDER.indexOf(data.station) : -1;

        STATION_ORDER.forEach(function (name, i) {
            var st = $('mcSt' + name.charAt(0).toUpperCase() + name.slice(1));
            if (!st) { return; }
            st.classList.toggle('is-active', i === activeIdx && !data.fault);
            st.classList.toggle('is-fault', i === activeIdx && Boolean(data.fault));
            st.classList.toggle('is-done', activeIdx > i);
        });

        var out = $('mcStOutput');
        if (out) {
            var atOutput = activeIdx === STATION_ORDER.length - 1;
            out.classList.toggle('is-accept', atOutput && data.result === 'ACCEPT');
            out.classList.toggle('is-reject', atOutput && data.result === 'REJECT');
        }

        var fill = $('mcCableFill');
        if (fill) {
            fill.setAttribute('width', String(Math.round((data.cableFraction || 0) * 960)));
        }
    }

    /* Global fault banner (visible on every screen while faulted). */
    function renderFaultBanner(data) {
        var banner = $('faultBanner');
        if (!banner) { return; }
        if (data.fault) {
            banner.hidden = false;
            setText('faultMessage', data.fault.message);
            setText('faultCondition', data.fault.condition || data.fault.code);
        } else {
            banner.hidden = true;
        }
    }

    /* Dashboard extras: step summary, result badge, process hint. */
    function renderDashboardExtras(data) {
        setText('dashStepText', data.stepIndex >= 0
            ? 'Step ' + (data.stepIndex + 1) + ' / 10 · ' + (data.stepLabel || '')
            : 'Step — / 10');

        if (data.fault) {
            applyStatus('dashResult', 'status-badge', 'FAULT', 'fault');
        } else if (data.result) {
            applyStatus('dashResult', 'status-badge', data.result,
                data.result === 'ACCEPT' ? 'pass' : 'reject');
        } else {
            applyStatus('dashResult', 'status-badge', 'WAITING', 'waiting');
        }

        var hint;
        if (data.fault) {
            hint = data.fault.message + ' — ' + data.fault.condition + '. Press RESET to clear.';
        } else if (data.state === 'IDLE') {
            hint = data.result
                ? 'Cycle finished: ' + data.result + '. Press START for the next specimen or RESET to clear.'
                : 'No process is active. Press START to run a demo preparation cycle.';
        } else if (!data.running) {
            hint = 'Machine stopped — press START to resume or RESET to clear.';
        } else {
            hint = 'Cycle in progress — live values from the Person 1 machine simulation.';
        }
        setText('dashProcessHint', hint);
    }

    /* Monitor extras: run/fault status, step counters, elapsed time, progress. */
    function renderMonitorExtras(data) {
        setText('monRunStatus', data.running ? 'RUNNING' : 'STOPPED');
        var run = $('monRunStatus');
        if (run) {
            run.classList.toggle('monitor-value--run', Boolean(data.running));
            run.classList.toggle('monitor-value--stop', !data.running);
        }

        setText('monFaultStatus', data.fault ? 'FAULT' : 'NORMAL');
        var fs = $('monFaultStatus');
        if (fs) {
            fs.classList.toggle('monitor-value--ok', !data.fault);
            fs.classList.toggle('monitor-value--fault', Boolean(data.fault));
        }

        setText('monStepStatus', data.stepIndex >= 0 ? (data.stepIndex + 1) + ' / 10' : '— / 10');
        setText('monProgressPct', Math.round(data.progress || 0) + '%');
        setWidth('monProgressBar', data.progress || 0);

        setText('monOperation', data.state || 'IDLE');
        setText('monStepLabel', data.stepLabel || '—');
        setText('monElapsed', formatElapsed(data.elapsedMs || 0));
        setText('monStepProgressPct', Math.round(data.stepProgress || 0) + '%');
        setWidth('monStepProgressBar', data.stepProgress || 0);
    }

    /* ---------- init ---------- */
    function init() {
        initNavigation();
        initClock();
        initControls();
        initConfigForm();
        initFaultDemo();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();


