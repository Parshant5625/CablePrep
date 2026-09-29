/* CablePrep HMI — live batch report and browser export. */
(function () {
    'use strict';
    window.CablePrep = window.CablePrep || {};

    var latest = null;

    function esc(value) {
        return String(value === null || typeof value === 'undefined' ? '—' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function valueHtml(value) {
        var text = String(value === null || typeof value === 'undefined' ? '—' : value);
        var status = ['READY','RUNNING','STOPPED','FAULT','ACCEPT','REJECT','WAITING','IDLE','COMPLETE'];
        if (status.indexOf(text.toUpperCase()) >= 0) {
            return '<span class="status-badge status-badge--sm status-badge--' +
                text.toLowerCase() + '">' + esc(text) + '</span>';
        }
        return esc(text);
    }

    function card(title, lines) {
        var html = '<div class="report-card"><div class="report-card-header">' +
            '<span class="panel-title">' + esc(title) + '</span></div>' +
            '<div class="report-card-body">';
        lines.forEach(function (line) {
            html += '<div class="report-line"><span class="report-line-key">' +
                esc(line[0]) + '</span><span class="report-line-val">' +
                valueHtml(line[1]) + '</span></div>';
        });
        return html + '</div></div>';
    }

    function getSummary() {
        var d = latest || {};
        var rows = window.CablePrep.History &&
            typeof window.CablePrep.History.getRows === 'function'
            ? window.CablePrep.History.getRows() : [];
        var accepted = rows.reduce(function (n, r) { return n + Number(r.accepted || 0); }, 0);
        var rejected = rows.reduce(function (n, r) { return n + Number(r.rejected || 0); }, 0);
        return {
            batch: d.batch || '—',
            state: d.state || 'IDLE',
            mode: d.mode || 'AUTOMATIC',
            cycleCount: Number(d.cycleCount || 0),
            result: d.result || 'WAITING',
            length: d.length,
            width: d.width,
            thickness: d.thickness,
            accepted: accepted,
            rejected: rejected,
            pending: Math.max(0, Number((rows.length ? rows[0].specimens : 0) || 0) -
                Number((rows.length ? rows[0].accepted : 0) || 0) -
                Number((rows.length ? rows[0].rejected : 0) || 0)),
            fault: d.fault ? d.fault.code : 'NONE',
            safety: d.safetyOK ? 'OK' : 'FAULT',
            timestamp: new Date().toLocaleString()
        };
    }

    function render(data) {
        if (data) { latest = data; }
        var grid = document.getElementById('reportGrid');
        if (!grid) { return; }
        var s = getSummary();

        grid.innerHTML =
            card('Batch Report', [
                ['Batch ID', s.batch],
                ['Standard', 'IS 10810 (simulation placeholder)'],
                ['Material', 'Configured HMI value'],
                ['Machine State', s.state],
                ['Report Status', s.state === 'FAULT' ? 'FAULT' : 'READY']
            ]) +
            card('Specimen / Inspection', [
                ['Result', s.result],
                ['Length', s.length === null || typeof s.length === 'undefined' ? '—' : s.length + ' mm'],
                ['Width', s.width === null || typeof s.width === 'undefined' ? '—' : s.width + ' mm'],
                ['Thickness', s.thickness === null || typeof s.thickness === 'undefined' ? '—' : s.thickness + ' mm'],
                ['Accepted (stored)', s.accepted],
                ['Rejected (stored)', s.rejected]
            ]) +
            card('Machine Summary', [
                ['Operating Mode', s.mode],
                ['Cycles Completed', s.cycleCount],
                ['Safety', s.safety],
                ['Fault', s.fault],
                ['Updated', s.timestamp]
            ]);
    }

    function printableHtml() {
        var s = getSummary();
        return '<!doctype html><html><head><meta charset="utf-8"><title>CablePrep Report</title>' +
            '<style>body{font-family:Arial,sans-serif;margin:40px;color:#111}h1{margin-bottom:4px}' +
            'table{border-collapse:collapse;width:100%;margin-top:24px}td,th{border:1px solid #bbb;padding:9px;text-align:left}' +
            '.note{margin-top:24px;font-size:12px;color:#555}</style></head><body>' +
            '<h1>CablePrep — Batch Report</h1><p>Virtual engineering prototype report</p><table>' +
            '<tr><th>Field</th><th>Value</th></tr>' +
            '<tr><td>Batch</td><td>' + esc(s.batch) + '</td></tr>' +
            '<tr><td>State</td><td>' + esc(s.state) + '</td></tr>' +
            '<tr><td>Result</td><td>' + esc(s.result) + '</td></tr>' +
            '<tr><td>Length</td><td>' + esc(s.length) + ' mm</td></tr>' +
            '<tr><td>Width</td><td>' + esc(s.width) + ' mm</td></tr>' +
            '<tr><td>Thickness</td><td>' + esc(s.thickness) + ' mm</td></tr>' +
            '<tr><td>Accepted</td><td>' + s.accepted + '</td></tr>' +
            '<tr><td>Rejected</td><td>' + s.rejected + '</td></tr>' +
            '<tr><td>Cycles</td><td>' + s.cycleCount + '</td></tr>' +
            '<tr><td>Fault</td><td>' + esc(s.fault) + '</td></tr></table>' +
            '<p class="note">Simulation values are placeholders and are not verified IS 10810 requirements.</p>' +
            '</body></html>';
    }

    function setFeedback(message) {
        var el = document.getElementById('reportFeedback');
        if (el) { el.textContent = message; }
    }

    function wireButtons() {
        var viewBtn = document.getElementById('btnViewReport');
        var exportBtn = document.getElementById('btnExportReport');

        if (viewBtn) {
            viewBtn.addEventListener('click', function () {
                var win = window.open('', '_blank');
                if (!win) {
                    setFeedback('Popup blocked. Allow popups to view the report.');
                    return;
                }
                win.document.open();
                win.document.write(printableHtml());
                win.document.close();
                setFeedback('Report opened in a printable browser window.');
            });
        }

        if (exportBtn) {
            exportBtn.addEventListener('click', function () {
                var blob = new Blob([printableHtml()], { type: 'text/html;charset=utf-8' });
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = 'CablePrep-' + (getSummary().batch || 'Report') + '.html';
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
                setFeedback('Report exported as an HTML file. Print it to PDF if required.');
            });
        }
    }

    window.CablePrep.Reports = {
        render: render,
        applyMachineData: function (data) { render(data); },
        getSummary: getSummary,
        exportHtml: function () { return printableHtml(); }
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