/* =====================================================================
   admin/export.js - CSV download and "Save as PDF" (print) for the dashboard
   csvDownload(filename, sections)  sections = [{ title, head, rows }]
   printSection(el)                 prints one tab only; the browser's print window offers "Save as PDF"
   ===================================================================== */

import { toast } from '../shared/utils.js';

/* one CSV cell. Numbers stay numbers (so Excel can add them up). Text that starts with = + - @ is
   prefixed with an apostrophe so a spreadsheet never runs it as a formula (CSV injection). */
function cell(v) {
    if (v === null || v === undefined)
        return '';
    if (typeof v === 'number')
        return Number.isFinite(v) ? String(v) : '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s))
        s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const line = a => a.map(cell).join(',');

/* HTML shown on screen -> plain text for the file */
export function plain(html) {
    const d = document.createElement('div');
    d.innerHTML = String(html ?? '');
    return d.textContent.replace(/\s+/g, ' ').trim();
}

/* Sections are written one after another, each with its title and a blank line between them.
   A UTF-8 byte-order mark makes Excel show the peso sign and accents correctly. */
export function csvDownload(filename, sections, meta = []) {
    const out = [];
    meta.forEach(m => out.push(line(m)));
    if (meta.length)
        out.push('');
    sections.forEach((s, i) => {
        if (i)
            out.push('');
        if (s.title)
            out.push(line([s.title]));
        if (s.head)
            out.push(line(s.head));
        s.rows.forEach(r => out.push(line(r)));
        if (!s.rows.length)
            out.push(line(['Nothing to show.']));
    });
    const blob = new Blob(['﻿' + out.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('Downloaded ' + filename);
}

/* Print only this tab (css/print.css hides everything else while body[data-print] is set). */
export function printSection(el) {
    const done = () => {
        document.body.removeAttribute('data-print');
        el.classList.remove('printing');
        window.removeEventListener('afterprint', done);
    };
    el.classList.add('printing');
    document.body.dataset.print = '1';
    window.addEventListener('afterprint', done);
    window.print();
}

export const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
