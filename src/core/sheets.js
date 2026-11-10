'use strict';
// Spreadsheets (.xlsx .xlsm .xlsb .xls .ods) and CSV/TSV to Markdown: one "## Sheet: name" section per sheet with a
// GitHub pipe table. Cells show the value as the spreadsheet formats it (dates, percentages). SheetJS CE (Apache-2.0)
// reads the file. Rows and columns are capped, with a note, so a huge sheet cannot fill the editor.
const XLSX = require('xlsx');
const M = require('./md');

const MAX_ROWS = 5000;
const MAX_COLS = 60;

function trimGrid(rows) {
  // drop empty rows at the end and empty columns on the right
  const isEmpty = (v) => v == null || String(v).trim() === '';
  let last = rows.length;
  while (last > 0 && rows[last - 1].every(isEmpty)) last--;
  const r = rows.slice(0, last).filter((row) => !row.every(isEmpty));
  let width = 0;
  for (const row of r) for (let i = row.length - 1; i >= width; i--) if (!isEmpty(row[i])) { width = i + 1; break; }
  return r.map((row) => row.slice(0, width).map((v) => (v == null ? '' : String(v))));
}

function sheetsToMarkdown(wb, ctx, { headings = true, maxRows = MAX_ROWS } = {}) {
  const out = [];
  const notes = [];
  const headingsList = [];
  const names = wb.SheetNames.slice(0, 500);
  let n = 0;
  for (const name of names) {
    ctx.progress(`Sheet ${++n} of ${names.length}`);
    const ws = wb.Sheets[name];
    if (!ws) continue;
    let rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false });
    rows = trimGrid(rows);
    const totalRows = rows.length;
    const totalCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    if (rows.length > maxRows) rows = rows.slice(0, maxRows);
    if (totalCols > MAX_COLS) rows = rows.map((r) => r.slice(0, MAX_COLS));
    const lines = [];
    if (headings) { lines.push(`## Sheet: ${M.escapeText(name)}`); headingsList.push({ level: 2, text: `Sheet: ${name}` }); }
    if (!rows.length) lines.push('*This sheet is empty.*');
    else lines.push(M.table(rows));
    if (totalRows > maxRows || totalCols > MAX_COLS) {
      const msg = `Only the first ${Math.min(totalRows, maxRows).toLocaleString('en-US')} of ${totalRows.toLocaleString('en-US')} rows and ${Math.min(totalCols, MAX_COLS)} of ${totalCols} columns are shown.`;
      lines.push(`*${msg}*`);
      notes.push(`${name}: ${msg}`);
    }
    out.push(lines.join('\n\n'));
    ctx.checkCancel();
  }
  return { markdown: M.tidy(out.join('\n\n')), headings: headingsList, notes, sheets: names.length };
}

async function workbook(buf, ctx) {
  ctx.progress('Reading the spreadsheet');
  let wb;
  try {
    wb = XLSX.read(buf, { type: 'buffer', dense: true, cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false, sheetRows: MAX_ROWS + 1, WTF: false });
  } catch (e) {
    const err = new Error(/password|encrypt/i.test(String(e && e.message)) ? 'This spreadsheet is password-protected. Remove the password in Excel and convert it again.' : `The spreadsheet could not be read: ${String((e && e.message) || e).slice(0, 200)}`);
    err.code = 'REFUSED';
    throw err;
  }
  const r = sheetsToMarkdown(wb, ctx);
  const title = (wb.Props && wb.Props.Title) || '';
  return { markdown: r.markdown, title, headings: r.headings, meta: { format: 'Spreadsheet', sheets: r.sheets }, notes: r.notes };
}

async function delimited(buf, ctx, sep) {
  ctx.progress('Reading the table');
  let text = Buffer.from(buf).toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const wb = XLSX.read(text, { type: 'string', raw: true, dense: true, sheetRows: MAX_ROWS + 1, FS: sep });
  const r = sheetsToMarkdown(wb, ctx, { headings: false });
  return { markdown: r.markdown, title: '', headings: [], meta: { format: sep === '\t' ? 'TSV table' : 'CSV table', rows: undefined }, notes: r.notes };
}

module.exports = { workbook, csv: (b, c) => delimited(b, c, undefined), tsv: (b, c) => delimited(b, c, '\t'), trimGrid, sheetsToMarkdown };
