/* ==========================================================================
 * CablePrep HMI — reports.js
 * Phase 1 : builds the report-screen structure and handles placeholder
 * buttons. No PDF/report generation is implemented yet.
 * ========================================================================== */
(function () {
    'use strict';

    window.CablePrep = window.CablePrep || {};

    /* Report sections shown as cards. "—" and status words are placeholders. */
    var SECTIONS = [
        {
            title: 'Batch Report',
            lines: [
                ['Batch ID', '—'],
                ['Standard', '—'],
                ['Material', '—'],
                ['Total Specimens', '—'],
                ['Report Status', 'WAITING']
            ]
        },
        {
            title: 'Specimen Results',
            lines: [
                ['Specimen 01', 'WAITING'],
                ['Specimen 02', 'WAITING'],
                ['Specimen 03', 'WAITING'],
                ['Specimen 04', 'WAITING']
            ]
        },
        {
            title: 'Inspection Summary',
            lines: [
                ['Accepted', '—'],
                ['Rejected', '—'],
                ['Pending', '—'],
                ['Inspection Status', 'WAITING']
            ]
        },
        {
            title: 'Machine Summary',
            lines: [
                ['Machine State', 'IDLE'],
                ['Operating Mode', 'AUTOMATIC'],
                ['Cycles Completed', '—'],
                ['Faults', '—']
            ]
        }
    ];

    /* Values that should be rendered as a small status badge. */
    var STATUS_WORDS = {
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

    function valueHtml(value) {
        var text = String(value);
        if (STATUS_WORDS[text.toLowerCase()]) {
            return '<span class="status-badge status-badge--sm status-badge--' +
                text.toLowerCase() + '">' + text + '</span>';
        }
        return text;
    }

    function cardHtml(section) {
        var html = '<div class="report-card">' +
            '<div class="report-card-header"><span class="panel-title">' + section.title + '</span></div>' +
            '<div class="report-card-body">';
        section.lines.forEach(function (line) {
            html += '<div class="report-line">' +
                '<span class="report-line-key">' + line[0] + '</span>' +
                '<span class="report-line-val">' + valueHtml(line[1]) + '</span>' +
                '</div>';
        });
        return html + '</div></div>';
    }

    function render() {
        var grid = document.getElementById('reportGrid');
        if (!grid) {
            return;
        }
        grid.innerHTML = SECTIONS.map(cardHtml).join('');
    }

    function setFeedback(message) {
        var el = document.getElementById('reportFeedback');
        if (el) {
            el.textContent = message;
        }
    }

    /* Placeholder buttons — real generation comes in a later phase. */
    function wireButtons() {
        var viewBtn = document.getElementById('btnViewReport');
        var exportBtn = document.getElementById('btnExportReport');

        if (viewBtn) {
            viewBtn.addEventListener('click', function () {
                setFeedback('Report viewing is not available in Phase 1 — report generation arrives in a later phase.');
            });
        }
        if (exportBtn) {
            exportBtn.addEventListener('click', function () {
                setFeedback('PDF export is not available in Phase 1 — report generation arrives in a later phase.');
            });
        }
    }

    /* Public API for later phases. */
    window.CablePrep.Reports = {
        render: render
    };

    function init() {
        render();
        wireButtons();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
