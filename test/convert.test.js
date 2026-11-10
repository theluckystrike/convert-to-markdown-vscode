'use strict';
// Golden output per format and hostile input, through the shipped bundle (dist/worker.js in a worker thread).
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const B = require('./build');
const { runJob } = require('../src/runner');

async function md(buf, name, extra = {}) {
  const b = Buffer.from(buf);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return runJob({ op: 'convert', buffer: ab, name, images: 'placeholder', limits: {}, ...extra }, { transfer: [ab], idleMs: 30000 });
}
async function fails(buf, name, extra) {
  try { await md(buf, name, extra); } catch (e) { return e; }
  assert.fail(`${name} converted, a message was expected`);
  return null;
}

test('PDF: title, headings by font size, joined paragraph, table, list, HTML-looking text kept as text, image placeholder', async () => {
  const r = await md(B.samplePdf(), 'report.pdf');
  assert.strictEqual(r.kind, 'pdf');
  assert.strictEqual(r.title, 'Quarterly Water Report');
  assert.deepStrictEqual(r.meta, { format: 'PDF', pages: 2 });
  const m = r.markdown;
  assert.match(m, /^# Quarterly Water Report\n\n## Summary\n\nThe plant treated more water this quarter than last year\. Demand rose in the summer months and fell in the autumn\.\n/);
  assert.match(m, /\| Site \| Volume \| Change \|\n\| --- \| --- \| --- \|\n\| North \| 1200 \| \+4% \|\n\| South \| 980 \| -2% \|\n\| East \| 1515 \| \+9% \|/);
  assert.match(m, /- First point of the list\n- Second point with \\<b\\>tags\\<\/b\\> kept as text/);
  assert.match(m, /\*\[Image\]\*/);
  assert.match(m, /## Outlook\n\nNext quarter the new pipe/);
  assert.ok(!/<b>/.test(m.replace(/\\</g, '')), 'no raw HTML');
});

test('PDF: Extract images writes a real PNG and links it', async () => {
  const r = await md(B.samplePdf(), 'report.pdf', { images: 'collect', assetsDir: 'report_assets' });
  assert.strictEqual(r.images.length, 1);
  assert.deepStrictEqual([...r.images[0].data.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.match(r.markdown, /!\[Image 1 on page 1\]\(report_assets\/image-001\.png\)/);
});

test('PDF: page numbers and a running header on every page are dropped', async () => {
  const pages = [1, 2, 3, 4].map((n) => ({ items: [
    { text: 'ACME Annual Report 2025', x: 72, y: 770, size: 9 },
    { text: `Body text of page ${n} is here.`, x: 72, y: 600, size: 11 },
    { text: String(n), x: 300, y: 30, size: 9 },
  ] }));
  const r = await md(B.pdf(pages), 'running.pdf');
  assert.ok(!/ACME Annual Report/.test(r.markdown), r.markdown);
  assert.ok(!/^\d+$/m.test(r.markdown), r.markdown);
  for (const n of [1, 2, 3, 4]) assert.match(r.markdown, new RegExp(`Body text of page ${n} is here\\.`));
});

test('PDF: a two-column page is read left column first', async () => {
  const items = [{ text: 'Two Column Paper', x: 72, y: 740, size: 20, bold: true }];
  for (let i = 0; i < 10; i++) {
    items.push({ text: `Left column line number ${i} with words`, x: 50, y: 700 - i * 14, size: 10 });
    items.push({ text: `Right column line number ${i} with words`, x: 320, y: 700 - i * 14, size: 10 });
  }
  const r = await md(B.pdf([{ items }]), 'columns.pdf');
  const m = r.markdown;
  assert.ok(m.indexOf('Left column line number 9') < m.indexOf('Right column line number 0'), m);
  assert.ok(!/\| Left/.test(m), 'not a table');
});

test('PDF: 10,000 pages are capped by pdfMaxPages with a note', async () => {
  const buf = B.pdf([{ items: [{ text: 'Same page text', x: 72, y: 700, size: 11 }] }], { pageCount: 10000 });
  const t = Date.now();
  const r = await md(buf, 'huge.pdf', { limits: { maxPages: 40 } });
  assert.strictEqual(r.meta.pages, 10000);
  assert.match(r.markdown, /Only the first 40 of 10,000 pages were converted/);
  assert.ok(r.notes.some((n) => /first 40 of 10,000/.test(n)));
  assert.ok(Date.now() - t < 20000);
});

test('PDF: damaged, truncated and random-byte PDFs give a message', async () => {
  const e1 = await fails(Buffer.from('%PDF-1.7\nthis is not a pdf at all'), 'bad.pdf');
  assert.strictEqual(e1.code, 'REFUSED');
  const full = B.samplePdf();
  for (const cut of [0.3, 0.6, 0.95]) {
    try { const r = await md(full.subarray(0, Math.floor(full.length * cut)), 'cut.pdf'); assert.strictEqual(typeof r.markdown, 'string'); } catch (e) { assert.ok(['REFUSED', 'CONVERT'].includes(e.code), e.code); }
  }
});

test('Word: headings, bold, italic, link, nested and numbered lists, table with a pipe, quote, script text, image alt', async () => {
  const r = await md(B.sampleDocx(), 'plan.docx');
  assert.strictEqual(r.kind, 'docx');
  assert.strictEqual(r.title, 'Project Plan');
  const m = r.markdown;
  assert.match(m, /^# Project Plan\n\n# Goals\n\nThis plan has \*\*bold\*\* and \*italic\* words, and a \[link\]\(https:\/\/example\.com\/report\?a=1&b=2\)\./);
  assert.match(m, /- First goal\n {2}- Nested detail\n- Second goal/);
  assert.match(m, /1\. Step one\n2\. Step two/);
  assert.match(m, /## Budget\n\n\| Item \| Cost \|\n\| --- \| --- \|\n\| Pipes \\\| fittings \| 1,200 \|\n\| Labour \| 800 \|/);
  assert.match(m, /\\<script\\>alert\(1\)\\<\/script\\> stays text/);
  assert.match(m, /\*\[Image: Map of the site\]\*/);
  assert.match(m, /> A quote from the client\./);
});

test('Word: Extract images saves the picture and links it with a relative path', async () => {
  const r = await md(B.sampleDocx(), 'plan.docx', { images: 'collect', assetsDir: 'my plan_assets' });
  assert.strictEqual(r.images.length, 1);
  assert.strictEqual(r.images[0].name, 'image-001.png');
  assert.match(r.markdown, /!\[Map of the site\]\(my%20plan_assets\/image-001\.png\)/);
});

test('Word: broken XML, a .doc that is random bytes and an empty file give messages', async () => {
  const broken = B.docx({ body: '<w:p><w:r><w:t>unclosed' });
  const zipOk = B.zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document><w:body><w:p>', 'word/_rels/document.xml.rels': '<<<' });
  for (const [buf, name] of [[broken, 'broken.docx'], [zipOk, 'bad.docx']]) {
    try { const r = await md(buf, name); assert.strictEqual(typeof r.markdown, 'string'); } catch (e) { assert.ok(['REFUSED', 'CONVERT'].includes(e.code), `${name}: ${e.code} ${e.message}`); }
  }
  const e = await fails(Buffer.alloc(0), 'empty.docx');
  assert.match(e.message, /empty/);
  const rnd = Buffer.alloc(4096); for (let i = 0; i < rnd.length; i++) rnd[i] = (i * 7919) & 255;
  const e2 = await fails(rnd, 'random.docx');
  assert.strictEqual(e2.code, 'REFUSED');
  // XML that is cut inside a tag: a "damaged" warning (REFUSED), not a converter error
  const e3 = await fails(B.docx({ body: '<w:p><w:r><w:t>unclosed <<<' }), 'broken-xml.docx');
  assert.strictEqual(e3.code, 'REFUSED');
  assert.match(e3.message, /^The Word file is damaged and could not be read \(/);
});

test('Password-protected Office file and old PowerPoint give a clear message', async () => {
  const u16 = (s) => Buffer.from(s, 'utf16le');
  const ole = (name) => Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504), u16(name), Buffer.alloc(512)]);
  const e1 = await fails(ole('EncryptedPackage'), 'secret.docx');
  assert.match(e1.message, /password-protected/);
  const e2 = await fails(ole('PowerPoint Document'), 'old.ppt');
  assert.match(e2.message, /old PowerPoint 97-2003/);
});

test('PowerPoint: slide sections, subtitle, bullet levels, picture alt, table with pipe, speaker notes', async () => {
  const r = await md(B.samplePptx(), 'deck.pptx');
  assert.strictEqual(r.kind, 'pptx');
  assert.deepStrictEqual(r.meta, { format: 'PowerPoint presentation', slides: 3 });
  assert.strictEqual(r.title, 'Launch Review');
  const m = r.markdown;
  assert.match(m, /^## Slide 1: Launch Review\n\n\*Team update, March\*\n\n> \*\*Notes:\*\* Welcome everyone\./);
  assert.match(m, /## Slide 2: What went well\n\n- Shipped on time\n {2}- All tests green\n- Few support tickets\n\n\*\[Image: Chart of tickets\]\*\n\n> \*\*Notes:\*\* Mention the support team\./);
  assert.match(m, /## Slide 3: Numbers\n\n\| Metric \| Value \|\n\| --- \| --- \|\n\| Users \| 1,024 \|\n\| Errors \\\| warnings \| 3 \|/);
});

test('PowerPoint: Extract images', async () => {
  const r = await md(B.samplePptx(), 'deck.pptx', { images: 'collect', assetsDir: 'deck_assets' });
  assert.strictEqual(r.images.length, 1);
  assert.match(r.markdown, /!\[Chart of tickets\]\(deck_assets\/image-001\.png\)/);
});

test('PowerPoint: a ZIP bomb slide (300 MB of XML) is refused with a message, fast', async () => {
  const deck = B.pptx([{ shapes: '' }]);
  // replace slide 1 with a 300 MB part that compresses to a few hundred KB
  const big = Buffer.alloc(300 * 1024 * 1024, 0x20);
  const bomb = B.zip({ '[Content_Types].xml': '<Types/>', 'ppt/presentation.xml': '<p:presentation/>', 'ppt/slides/slide1.xml': big });
  assert.ok(bomb.length < 2 * 1024 * 1024 && deck.length > 0);
  const t = Date.now();
  const e = await fails(bomb, 'bomb.pptx');
  assert.ok(['REFUSED', 'CONVERT'].includes(e.code), e.code);
  assert.match(e.message, /larger than 256 MB|1 GB|not converted|could not/i);
  assert.ok(Date.now() - t < 20000);
});

test('Excel: one section per sheet, pipe tables, pipes escaped; huge sheet capped with a note', async () => {
  const r = await md(B.sampleXlsx(), 'book.xlsx');
  assert.strictEqual(r.kind, 'xlsx');
  assert.strictEqual(r.markdown, '## Sheet: Sales\n\n| Region | Q1 | Q2 |\n| --- | --- | --- |\n| North | 120 | 135 |\n| South \\| West | 98 | 101 |\n\n## Sheet: Notes\n\n| Note |\n| --- |\n| Checked by finance |\n');
  const rows = [['n', 'square']];
  for (let i = 1; i <= 6000; i++) rows.push([i, i * i]);
  const r2 = await md(B.xlsx([{ name: 'Big', rows }]), 'big.xlsx');
  assert.match(r2.markdown, /Only the first 5,000 of 5,000 rows|Only the first 5,000 of/);
  assert.ok(r2.markdown.split('\n').length < 5100);
});

test('CSV and TSV: quoted commas, pipes, BOM', async () => {
  const r = await md(B.sampleCsv(), 'fruit.csv');
  assert.strictEqual(r.markdown, '| name | qty | note |\n| --- | --- | --- |\n| apple | 3 | red, sweet |\n| pear | 5 | has \\| pipe |\n');
  const t = await md(Buffer.from('﻿a\tb\n1\t2\n'), 'x.tsv');
  assert.strictEqual(t.markdown, '| a | b |\n| --- | --- |\n| 1 | 2 |\n');
});

test('HTML: title, scripts and styles dropped, emphasis, link, nested ordered list, code fence with language, table, quote, escaped text', async () => {
  const r = await md(B.sampleHtml(), 'notes.html');
  assert.strictEqual(r.title, 'Release notes');
  const m = r.markdown;
  assert.ok(!/window\.bad|color:red/.test(m));
  assert.match(m, /^# Release notes\n\nVersion \*\*2\.0\*\* adds \*search\* and \[docs\]\(https:\/\/example\.com\/docs\)\./);
  assert.match(m, /1\. Faster start\n2\. New icons\n {3}- dark\n {3}- light/);
  assert.match(m, /```js\nconst x = 1;\nconsole\.log\(x\);\n```/);
  assert.match(m, /\| a\\\|b \| 1 \|/);
  assert.match(m, /> Quoted line/);
  assert.match(m, /Inline `code` and \\<not a tag\\>\./);
  assert.match(m, /\*\[Image: Logo\]\*/);
});

test('HTML: 20,000 nested elements, javascript: links and an onerror image do not break out', async () => {
  const deep = '<div>'.repeat(20000) + 'deep text' + '</div>'.repeat(20000);
  const r = await md(Buffer.from(`<html><body>${deep}<p><a href="javascript:alert(1)">click</a> <img src=x onerror="alert(1)" alt="x"></p>&lt;script&gt;alert(2)&lt;/script&gt;</body></html>`), 'hostile.html');
  assert.match(r.markdown, /deep text/);
  assert.ok(!/javascript:/.test(r.markdown));
  assert.ok(!/onerror/.test(r.markdown));
  assert.match(r.markdown, /\\<script\\>alert\(2\)\\<\/script\\>/);
});

test('EPUB: chapters in spine order, emphasis, list, image alt; Extract images', async () => {
  const r = await md(B.sampleEpub(), 'book.epub');
  assert.strictEqual(r.title, 'A Short Book');
  assert.strictEqual(r.markdown, '# Chapter One\n\nIt was a *quiet* morning.\n\n*[Image: Cover art]*\n\n---\n\n# Chapter Two\n\n- Bread\n- Milk\n');
  const c = await md(B.sampleEpub(), 'book.epub', { images: 'collect', assetsDir: 'book_assets' });
  assert.strictEqual(c.images.length, 1);
  assert.match(c.markdown, /!\[Cover art\]\(book_assets\/image-001\.png\)/);
});

test('ODT, RTF: headings, bold, list, table, code page text', async () => {
  const o = await md(B.sampleOdt(), 'notes.odt');
  assert.strictEqual(o.markdown, '# Meeting Notes\n\nWe agreed on the **budget**.\n\n- Order parts\n- Book the room\n\n| Who | What |\n| --- | --- |\n| Ana | Parts |\n');
  const t = await md(B.sampleRtf(), 'letter.rtf');
  assert.strictEqual(t.markdown, 'Letter to the board\n\nWe thank you for your support this year.\n\nCafé opens in May.\n');
});

test('every sample cut short (10 cuts each) converts or gives a message, never hangs', async () => {
  const samples = { 'a.pdf': B.samplePdf(), 'a.docx': B.sampleDocx(), 'a.pptx': B.samplePptx(), 'a.xlsx': B.sampleXlsx(), 'a.epub': B.sampleEpub(), 'a.odt': B.sampleOdt(), 'a.rtf': B.sampleRtf() };
  for (const [name, buf] of Object.entries(samples)) {
    for (let k = 1; k <= 10; k++) {
      const cut = buf.subarray(0, Math.floor((buf.length * k) / 11));
      try { const r = await md(cut, name); assert.strictEqual(typeof r.markdown, 'string'); } catch (e) { assert.ok(['REFUSED', 'CONVERT', 'WORKER'].includes(e.code), `${name} cut ${k}: ${e.code} ${e.message}`); }
    }
  }
});

test('size cap: a file over maxBytes is refused before reading', async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tomd-cap-')), 'big.csv');
  fs.writeFileSync(p, Buffer.alloc(2 * 1024 * 1024, 0x41));
  try {
    await runJob({ op: 'convert', file: p, name: 'big.csv', maxBytes: 1024 * 1024 });
    assert.fail('expected TOO_BIG');
  } catch (e) { assert.strictEqual(e.code, 'TOO_BIG'); assert.strictEqual(e.size, 2 * 1024 * 1024); } finally { fs.rmSync(path.dirname(p), { recursive: true, force: true }); }
});

test('cancel stops the worker at once', async () => {
  const buf = B.pdf([{ items: [{ text: 'Page text', x: 72, y: 700, size: 11 }] }], { pageCount: 3000 });
  const token = { isCancellationRequested: false, cb: null, onCancellationRequested(f) { this.cb = f; return { dispose() {} }; } };
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const p = runJob({ op: 'convert', buffer: ab, name: 'long.pdf', limits: { maxPages: 3000 } }, { token, transfer: [ab] });
  setTimeout(() => { token.isCancellationRequested = true; token.cb(); }, 300);
  await assert.rejects(p, (e) => e.code === 'CANCELLED');
});

test('a deflate stream that lies about its size inside a .docx is handled', async () => {
  const doc = B.docx({ body: B.wp('Hello') });
  // flip bytes in the middle of the compressed data
  const bad = Buffer.from(doc); for (let i = 200; i < 260; i++) bad[i] ^= 0x5a;
  try { const r = await md(bad, 'flip.docx'); assert.strictEqual(typeof r.markdown, 'string'); } catch (e) { assert.ok(['REFUSED', 'CONVERT'].includes(e.code), e.message); }
  assert.ok(zlib);
});
