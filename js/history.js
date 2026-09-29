/* CablePrep HMI — persistent cycle history.
 * Stores completed HMI records locally in the browser. This is prototype
 * traceability only; it is not a production database.
 */
(function () {
    'use strict';
    window.CablePrep = window.CablePrep || {};

    var KEY = 'cableprep.history.v1';
    var DEMO_ROWS = [
        { batch: 'DEMO-001', specimens: 4, accepted: 4, rejected: 0, date: 'Demo', status: 'COMPLETE' },
        { batch: 'DEMO-002', specimens: 4, accepted: 3, rejected: 1, date: 'Demo', status: 'COMPLETE' }
    ];
    var liveRows = load();

    function load() {
        try {
            var parsed = JSON.parse(window.localStorage.getItem(KEY) || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    function persist() {
        try {
            window.localStorage.setItem(KEY, JSON.stringify(liveRows));
        } catch (e) {
            /* file:// or privacy-restricted browsers may disable storage. */
        }
    }

    function badgeHtml(status) {
        var variant = String(status || 'WAITING').toLowerCase();
        return '<span class="status-badge status-badge--' + variant + '">' +
            String(status || 'WAITING') + '</span>';
    }

    function rowHtml(row) {
        return '<tr>' +
            '<td class="cell-strong cell-mono">' + row.batch + '</td>' +
            '<td class="cell-center cell-mono">' + Number(row.specimens || 0) + '</td>' +
            '<td class="cell-center cell-mono">' + Number(row.accepted || 0) + '</td>' +
            '<td class="cell-center cell-mono">' + Number(row.rejected || 0) + '</td>' +
            '<td class="cell-mono">' + (row.date || '—') + '</td>' +
            '<td>' + badgeHtml(row.status) + '</td>' +
            '</tr>';
    }

    function rowsForDisplay() {
        return liveRows.slice().reverse().concat(DEMO_ROWS);
    }

    function render(rows) {
        var body = document.getElementById('historyTableBody');
        if (!body) { return; }
        var displayRows = Array.isArray(rows) ? rows : rowsForDisplay();
        body.innerHTML = displayRows.map(rowHtml).join('');
    }

    function addRun(run) {
        if (!run || !run.batch) { return false; }

        var existing = null;
        liveRows.forEach(function (row) {
            if (row.batch === run.batch) { existing = row; }
        });

        if (existing) {
            existing.specimens = Number(existing.specimens || 0) + Number(run.specimens || 1);
            existing.accepted = Number(existing.accepted || 0) + Number(run.accepted || 0);
            existing.rejected = Number(existing.rejected || 0) + Number(run.rejected || 0);
            existing.date = run.date || existing.date;
            existing.status = run.status || existing.status;
        } else {
            liveRows.push({
                batch: String(run.batch),
                specimens: Number(run.specimens || 1),
                accepted: Number(run.accepted || 0),
                rejected: Number(run.rejected || 0),
                date: run.date || new Date().toLocaleString(),
                status: run.status || 'COMPLETE',
                lastResult: run.lastResult || null
            });
        }
        persist();
        render();
        return true;
    }

    function getRows() {
        return liveRows.slice().reverse();
    }

    function clear() {
        liveRows = [];
        persist();
        render();
    }

    window.CablePrep.History = {
        render: render,
        addRun: addRun,
        getRows: getRows,
        getDemoRows: function () { return DEMO_ROWS.slice(); },
        clear: clear
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', render);
    } else {
        render();
    }
})();