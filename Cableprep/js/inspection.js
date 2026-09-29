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

        if (data.result) {
            /* Finalized: parameter statuses follow the simulated result. */
            var fail = data.resultParameter;
            parameters.forEach(function (p) {
                if (measured) {
                    if (p.id === 'length') { setMeasuredValue(p, data.length); }
                    if (p.id === 'width') { setMeasuredValue(p, data.width); }
                    if (p.id === 'thickness') { setMeasuredValue(p, data.thickness); }
                }
                if (p.id === 'shape') { p.value = 'REGULAR (demo)'; }
                if (p.id === 'surface') { p.value = 'OK (demo)'; }
                p.status = (data.result === 'REJECT' && p.id === fail) ? 'REJECT' : 'PASS';
            });
            setFinalResult(data.result, data.result === 'REJECT'
                ? 'Demo deviation on: ' + (fail || 'parameter') +
                  ' — DEMO PARAMETERS, NOT VERIFIED IS 10810 VALUES.'
                : 'All demo parameters within demo limits — DEMO PARAMETERS, NOT VERIFIED IS 10810 VALUES.');
        } else if (measured) {
            /* Mid-cycle: measurements received, evaluation still pending. */
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
            /* Fresh idle / reset: return everything to WAITING. */
            parameters.forEach(function (p) {
                p.value = null;
                p.status = 'WAITING';
            });
            setFinalResult('WAITING');
            setDetail('No inspection result yet. The mock machine reports a simulated result after INSPECTING.');
        } else {
            return; /* other mid-cycle states: nothing to update */
        }

        /* Re-render only when the visible rows actually changed. */
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
