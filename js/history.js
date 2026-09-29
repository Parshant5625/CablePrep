/* ==========================================================================
 * CablePrep HMI — history.js
 * Phase 1 : renders the batch-history table with STATIC DEMO rows.
 *
 * No LocalStorage / persistence yet — real history handling is a later
 * phase. Replace the demo rows via CablePrep.History.render(rows).
 * ========================================================================== */
(function () {
    'use strict';

    window.CablePrep = window.CablePrep || {};

    /* Clearly marked demo data (the Date column reads "Demo" on purpose). */
    var DEMO_ROWS = [
        { batch: 'CP-001', specimens: 4, accepted: 4, rejected: 0, date: 'Demo', status: 'COMPLETE' },
        { batch: 'CP-002', specimens: 4, accepted: 3, rejected: 1, date: 'Demo', status: 'COMPLETE' },
        { batch: 'CP-003', specimens: 4, accepted: 0, rejected: 0, date: 'Demo', status: 'RUNNING' }
    ];

    /* Builds a status badge (values come from our own model, not user input). */
    function badgeHtml(status) {
        var variant = String(status).toLowerCase();
        return '<span class="status-badge status-badge--' + variant + '">' + status + '</span>';
    }

    function rowHtml(row) {
        return '<tr>' +
            '<td class="cell-strong cell-mono">' + row.batch + '</td>' +
            '<td class="cell-center cell-mono">' + row.specimens + '</td>' +
            '<td class="cell-center cell-mono">' + row.accepted + '</td>' +
            '<td class="cell-center cell-mono">' + row.rejected + '</td>' +
            '<td class="cell-mono">' + row.date + '</td>' +
            '<td>' + badgeHtml(row.status) + '</td>' +
            '</tr>';
    }

    function render(rows) {
        var body = document.getElementById('historyTableBody');
        if (!body) {
            return;
        }
        var data = rows || DEMO_ROWS;
        body.innerHTML = data.map(rowHtml).join('');
    }

    /* Phase 2: prepend/merge a completed run above the demo rows.
       In-memory only — real persistence belongs to a later phase. */
    var liveRows = [];

    function addRun(run) {
        if (!run || !run.batch) {
            return false;
        }
        var existing = null;
        liveRows.forEach(function (row) {
            if (row.batch === run.batch) {
                existing = row;
            }
        });
        if (existing) {
            existing.specimens += run.specimens || 1;
            existing.accepted += run.accepted || 0;
            existing.rejected += run.rejected || 0;
            existing.date = run.date || existing.date;
        } else {
            liveRows.unshift({
                batch: run.batch,
                specimens: run.specimens || 1,
                accepted: run.accepted || 0,
                rejected: run.rejected || 0,
                date: run.date || 'Live',
                status: run.status || 'COMPLETE'
            });
        }
        render(liveRows.concat(DEMO_ROWS));
        return true;
    }

    /* Public API for later phases. */
    window.CablePrep.History = {
        render: render,
        addRun: addRun,
        getDemoRows: function () {
            return DEMO_ROWS.slice();
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            render();
        });
    } else {
        render();
    }
})();
