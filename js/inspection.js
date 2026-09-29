/* ==========================================================================
 * CablePrep HMI — inspection.js
 * Phase 1 : renders the static "Specimen Inspection" structure.
 *
 * This module only holds a placeholder data model (all statuses WAITING).
 * No measurement, machine vision or PASS/REJECT logic is implemented.
 * Later phases can update the UI through CablePrep.Inspection.* helpers.
 * ========================================================================== */
(function () {
    'use strict';

    window.CablePrep = window.CablePrep || {};

    /* Placeholder model — measured values are intentionally empty. */
    var parameters = [
        { id: 'length',    label: 'Length',    value: null, status: 'WAITING' },
        { id: 'width',     label: 'Width',     value: null, status: 'WAITING' },
        { id: 'thickness', label: 'Thickness', value: null, status: 'WAITING' },
        { id: 'shape',     label: 'Shape',     value: null, status: 'WAITING' },
        { id: 'surface',   label: 'Surface',   value: null, status: 'WAITING' }
    ];

    /* Builds a status badge (values come from our own model, not user input). */
    function badgeHtml(status) {
        var variant = String(status).toLowerCase();
        return '<span class="status-badge status-badge--' + variant + '">' + status + '</span>';
    }

    function render() {
        var body = document.getElementById('inspectionParamBody');
        if (!body) {
            return;
        }
        body.innerHTML = parameters.map(function (param) {
            return '<tr>' +
                '<td class="cell-strong">' + param.label + '</td>' +
                '<td class="cell-mono">' + (param.value === null ? '—' : param.value) + '</td>' +
                '<td>' + badgeHtml(param.status) + '</td>' +
                '</tr>';
        }).join('');
    }

    /* ------------------------------------------------------------------
     * Phase 2: consume normalized machine data
     * (called from CablePrep.App.updateMachineData on every update)
     * ------------------------------------------------------------------ */
    var lastSignature = null;

    function setDetail(text) {
        var el = document.getElementById('inspResultDetail');
        if (el) {
            el.textContent = text;
        }
    }

    function setMeasuredValue(p, value) {
        if (value === null || typeof value === 'undefined') {
            p.value = null;
        } else {
            p.value = value + ' mm';
        }
    }

    /* Local result setter (also exposed through the public API below).
       Accepts ACCEPT | REJECT | PASS | WAITING. */
    function setFinalResult(status, detail) {
        var el = document.getElementById('inspFinalResult');
        if (el) {
            var value = String(status || 'WAITING').toUpperCase();
            var styles = { ACCEPT: 'pass', PASS: 'pass', REJECT: 'reject', WAITING: 'waiting' };
            el.textContent = value === 'WAITING' ? 'WAITING FOR INSPECTION' : value;
            el.className = 'status-badge status-badge--' +
                (styles[value] || 'waiting') + ' result-badge';
        }
        if (typeof detail === 'string') {
            setDetail(detail);
        }
    }

    function applyMachineData(data) {
        if (!data) {
            return;
        }

        var measured = data.length !== null && typeof data.length !== 'undefined';
        var finalResult = String(data.result || '').toUpperCase();
        var reasons = Array.isArray(data.inspection && data.inspection.reasons)
            ? data.inspection.reasons
            : [];

        function reasonFor(id) {
            var needle = String(id).toLowerCase();
            for (var i = 0; i < reasons.length; i++) {
                var reason = String(reasons[i]).toLowerCase();
                if (reason.indexOf(needle) >= 0) {
                    return true;
                }
            }
            return false;
        }

        if (finalResult === 'ACCEPT' || finalResult === 'REJECT') {
            parameters.forEach(function (p) {
                if (p.id === 'length') { setMeasuredValue(p, data.length); }
                if (p.id === 'width') { setMeasuredValue(p, data.width); }
                if (p.id === 'thickness') { setMeasuredValue(p, data.thickness); }
                if (p.id === 'shape') { p.value = 'REGULAR (demo)'; }
                if (p.id === 'surface') { p.value = 'OK (demo)'; }

                if (finalResult === 'ACCEPT') {
                    p.status = 'PASS';
                } else {
                    /* Reject only the parameter(s) named by the vision reason.
                       Other measured parameters remain PASS. */
                    p.status = reasonFor(p.id) ? 'REJECT' : 'PASS';
                }
            });

            setFinalResult(finalResult, finalResult === 'REJECT'
                ? 'Inspection rejected the specimen. ' +
                  (reasons.length ? reasons.join(' | ') : 'See machine fault/result data.') +
                  ' — DEMO PARAMETERS, NOT VERIFIED IS 10810 VALUES.'
                : 'All demo inspection parameters passed — DEMO PARAMETERS, NOT VERIFIED IS 10810 VALUES.');

        } else if (measured) {
            parameters.forEach(function (p) {
                if (p.id === 'length') { setMeasuredValue(p, data.length); }
                if (p.id === 'width') { setMeasuredValue(p, data.width); }
                if (p.id === 'thickness') { setMeasuredValue(p, data.thickness); }
                if (p.id === 'shape' || p.id === 'surface') { p.value = null; }
                p.status = 'WAITING';
            });
            setFinalResult('WAITING');
            setDetail('Measurements received — waiting for the inspection result.');

        } else if (data.state === 'IDLE') {
            parameters.forEach(function (p) {
                p.value = null;
                p.status = 'WAITING';
            });
            setFinalResult('WAITING');
            setDetail(data.cycleCount
                ? 'Cycle complete. Start a new specimen when ready.'
                : 'No inspection result yet. Press START to run a preparation cycle.');

        } else {
            return;
        }

        var sig = parameters.map(function (p) {
            return p.id + ':' + p.value + ':' + p.status;
        }).join('|');
        if (sig !== lastSignature) {
            lastSignature = sig;
            render();
        }
    }

    /* Public API for the HMI (Phase 1 + Phase 2). */
    window.CablePrep.Inspection = {
        render: render,
        applyMachineData: applyMachineData,

        /* e.g. CablePrep.Inspection.setParameter('length', { value: '100 mm', status: 'PASS' }) */
        setParameter: function (id, update) {
            parameters.forEach(function (param) {
                if (param.id === id) {
                    if (update && typeof update.value !== 'undefined') {
                        param.value = update.value;
                    }
                    if (update && update.status) {
                        param.status = update.status;
                    }
                }
            });
            render();
        },

        /* e.g. CablePrep.Inspection.setFinalResult('ACCEPT', 'detail text') */
        setFinalResult: setFinalResult
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', render);
    } else {
        render();
    }
})();
