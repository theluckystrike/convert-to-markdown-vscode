'use strict';
// Markdown writing helpers shared by every converter: escaping, GitHub pipe tables, clean-up.

/** Escape text so it shows as written (no emphasis, no links, no HTML). */
function escapeText(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/([`*[\]<>])/g, '\\$1')
    .replace(/(^|[^\w])_|_(?=[^\w]|$)/g, (m) => m.replace('_', '\\_'));
}

/** Escape a whole line: also the characters that start a block at the beginning of a line. */
function escapeLine(s) {
  let t = escapeText(s);
  t = t.replace(/^(\s*)([#>+=|-])/, '$1\\$2').replace(/^(\s*)(\d+)([.)])(\s)/, '$1$2\\$3$4');
  return t;
}

function cell(s, raw) {
  const v = String(s == null ? '' : s);
  const t = (raw ? v : escapeText(v)).replace(/\|/g, '\\|').replace(/\r?\n+/g, '<br>').replace(/\s+/g, ' ').trim();
  return t;
}

/** rows: array of arrays of strings. The first row is the header. Returns '' for an empty table. */
function table(rows, { header = true, maxCols = 200, raw = false } = {}) {
  const r = rows.filter((x) => Array.isArray(x));
  if (!r.length) return '';
  const cols = Math.min(maxCols, r.reduce((m, x) => Math.max(m, x.length), 1));
  const pad = (x) => { const o = x.slice(0, cols).map((c) => cell(c, raw)); while (o.length < cols) o.push(''); return o; };
  const lines = [];
  const head = header ? pad(r[0]) : Array.from({ length: cols }, (_, i) => `Column ${i + 1}`);
  lines.push(`| ${head.map((c) => c || ' ').join(' | ')} |`);
  lines.push(`|${' --- |'.repeat(cols)}`);
  for (const x of header ? r.slice(1) : r) lines.push(`| ${pad(x).join(' | ')} |`);
  return lines.join('\n');
}

/** Collapse 3+ blank lines, trim trailing spaces, end with one newline. */
function tidy(md) {
  return String(md)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n*$/, '\n');
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'section';
}

/** A file name that is safe on every OS. */
function safeName(s, fallback = 'file') {
  const t = String(s).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-').replace(/^[.\s-]+|[.\s]+$/g, '').slice(0, 80);
  return t || fallback;
}

module.exports = { escapeText, escapeLine, cell, table, tidy, slug, safeName };
