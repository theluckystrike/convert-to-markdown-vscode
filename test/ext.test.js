'use strict';
// The extension host with a stub vscode: activation, Convert and Copy, messages for bad files, the three Pro tools
// (tries counted only after output, Escape keeps a try, the CARD1 panel on the 4th click), package.json rules.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const B = require('./build');
const { loadExtension } = require('./support/vscode-stub');
const pkg = require('../package.json');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tomd-ext-'));
const file = (rel, buf) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); return p; };
const DOCX = file('docs/plan.docx', B.sampleDocx());
const PDF = file('docs/sub/report.pdf', B.samplePdf());
const PPTX = file('docs/deck.pptx', B.samplePptx());
const XLSX = file('docs/book.xlsx', B.sampleXlsx());
file('docs/readme.txt', 'not converted');
file('docs/node_modules/skip.pdf', B.samplePdf());
const BAD = file('bad/random.docx', Buffer.from('this is not a word file at all'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const CARD1 = ['Pay by card (USD 19)', 'Get Zovo Pro with GitHub Sponsors', 'Pay with PayPal', 'Enter a key'];

function trapNetwork() {
  const calls = [];
  const saved = { fetch: global.fetch, hr: http.request, hg: http.get, sr: https.request, sg: https.get, nc: net.connect, ncc: net.createConnection };
  global.fetch = async (u) => { calls.push(String(u)); throw new Error('network blocked in test'); };
  http.request = http.get = https.request = https.get = (...a) => { calls.push(String(a[0] && (a[0].href || a[0].host || a[0]))); throw new Error('network blocked in test'); };
  net.connect = net.createConnection = (...a) => { calls.push('net ' + JSON.stringify(a[0])); throw new Error('network blocked in test'); };
  return { calls, restore: () => { global.fetch = saved.fetch; http.request = saved.hr; http.get = saved.hg; https.request = saved.sr; https.get = saved.sg; net.connect = saved.nc; net.createConnection = saved.ncc; } };
}
const pick = (id) => (items) => items.find((i) => i.id === id);
const tries = (s) => s.state.get('toMarkdown.proTrial') || {};

test('activation registers the commands, makes no network call and shows nothing; Convert opens an unsaved .md beside the file', async () => {
  const nw = trapNetwork();
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    for (const c of ['toMarkdown.convert', 'toMarkdown.copyAsMarkdown', 'toMarkdown.convertFolder', 'toMarkdown.convertWithImages', 'toMarkdown.convertForLlm', 'toMarkdown.convertSample', 'toMarkdown.getPro', 'toMarkdown.enterLicenseKey', 'toMarkdown.payByCard']) assert.ok(s.commands.has(c), c);
    assert.deepStrictEqual([s.log.info.length, s.log.warn.length, s.log.error.length, s.log.status.length], [0, 0, 0, 0], 'nothing on activation');
    await s.commands.get('toMarkdown.convert')(s.vscode.Uri.file(DOCX));
    const d = s.log.opened.at(-1);
    assert.strictEqual(d.uri.scheme, 'untitled');
    assert.strictEqual(d.uri.path, path.join(dir, 'docs', 'plan.md'));
    assert.strictEqual(d.languageId, 'markdown');
    assert.match(d.getText(), /^# Project Plan\n/);
    assert.ok(s.log.status.some((t) => /Converted plan\.docx to Markdown/.test(t)));
    assert.ok(!fs.existsSync(path.join(dir, 'docs', 'plan.md')), 'nothing written in untitled mode');
    // the same file again: a second untitled name
    await s.commands.get('toMarkdown.convert')(s.vscode.Uri.file(DOCX));
    assert.strictEqual(path.basename(s.log.opened.at(-1).uri.path), 'plan (2).md');
    // the active tab is used when the command has no argument
    s.vscode.window.tabGroups.activeTabGroup.activeTab = { input: { uri: s.vscode.Uri.file(PPTX) } };
    await s.commands.get('toMarkdown.convert')();
    assert.match(s.log.opened.at(-1).getText(), /## Slide 1: Launch Review/);
    s.vscode.window.tabGroups.activeTabGroup.activeTab = undefined;
    assert.deepStrictEqual(nw.calls, []);
    assert.deepStrictEqual(s.log.external, []);
    assert.deepStrictEqual([s.log.warn.length, s.log.error.length], [0, 0]);
    assert.ok(!s.log.info.some((m) => /Pro/.test(m.text)), 'nothing about Pro');
  } finally { nw.restore(); s.restore(); }
});

test('Output = file saves name.md next to the source; an existing file asks Replace or Keep both; Copy as Markdown', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    s.config.output = 'file';
    await s.commands.get('toMarkdown.convert')(s.vscode.Uri.file(XLSX));
    const out = path.join(dir, 'docs', 'book.md');
    assert.match(fs.readFileSync(out, 'utf8'), /^## Sheet: Sales\n/);
    s.ui.warn.push('Keep both');
    await s.commands.get('toMarkdown.convert')(s.vscode.Uri.file(XLSX));
    assert.ok(fs.existsSync(path.join(dir, 'docs', 'book (2).md')));
    s.ui.warn.push(undefined); // Escape: nothing written
    await s.commands.get('toMarkdown.convert')(s.vscode.Uri.file(XLSX));
    assert.ok(!fs.existsSync(path.join(dir, 'docs', 'book (3).md')));
    fs.rmSync(out); fs.rmSync(path.join(dir, 'docs', 'book (2).md'));
    await s.commands.get('toMarkdown.copyAsMarkdown')(s.vscode.Uri.file(PDF));
    assert.match(s.log.clipboard, /^# Quarterly Water Report/);
    assert.ok(s.log.status.some((t) => /Copied report\.pdf as Markdown/.test(t)));
  } finally { s.restore(); }
});

test('a file that is not what its name says gives a warning, no error, and the next file converts', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    await s.commands.get('toMarkdown.convert')(s.vscode.Uri.file(BAD));
    assert.strictEqual(s.log.warn.length, 1);
    assert.match(s.log.warn[0].text, /^random\.docx: This file is not one of the supported formats/);
    assert.strictEqual(s.log.error.length, 0);
    await s.commands.get('toMarkdown.convert')(s.vscode.Uri.file(DOCX));
    assert.match(s.log.opened.at(-1).getText(), /Project Plan/);
    s.config.maxFileSizeMB = 1;
    await s.commands.get('toMarkdown.convert')(s.vscode.Uri.file(file('bad/big.csv', Buffer.alloc(1024 * 1024 + 10, 0x41))));
    assert.match(s.log.warn.at(-1).text, /Files up to .* MB are converted \(setting toMarkdown\.maxFileSizeMB\)/);
  } finally { s.restore(); }
});

test('Pro: Convert a whole folder: mirrored tree, report, skip/overwrite; Escape and "skip all" use no try; 4th click shows the CARD1 panel', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const root = path.join(dir, 'docs');
    const outRoot = path.join(dir, 'docs-markdown');
    s.ui.open.push(undefined); // Escape on the folder dialog
    await s.commands.get('toMarkdown.convertFolder')();
    assert.strictEqual(tries(s).folder, undefined);
    s.ui.quick.push(pick('mirror'));
    await s.commands.get('toMarkdown.convertFolder')(s.vscode.Uri.file(root));
    for (const rel of ['plan.md', 'deck.md', 'book.md', 'sub/report.md']) assert.ok(fs.existsSync(path.join(outRoot, rel)), rel);
    assert.ok(!fs.existsSync(path.join(outRoot, 'node_modules')), 'node_modules skipped');
    assert.ok(!fs.existsSync(path.join(outRoot, 'readme.md')), 'txt not converted');
    const report = fs.readFileSync(path.join(outRoot, '_conversion-report.md'), 'utf8');
    assert.match(report, /- Converted: 4, skipped: 0, failed: 0/);
    assert.match(report, /\| sub\/report\.pdf \| converted \| \[sub\/report\.md\]\(<sub\/report\.md>\) \| 2 pages/);
    assert.strictEqual(tries(s).folder, 1);
    assert.ok(s.log.status.some((t) => /free try 1 of 3/.test(t)));
    // again: skip all existing -> nothing converted -> no try
    s.ui.quick.push(pick('mirror'), pick('skip'));
    await s.commands.get('toMarkdown.convertFolder')(s.vscode.Uri.file(root));
    assert.match(fs.readFileSync(path.join(outRoot, '_conversion-report.md'), 'utf8'), /- Converted: 0, skipped: 4, failed: 0/);
    assert.strictEqual(tries(s).folder, 1);
    // Escape on the skip/overwrite pick keeps the try
    s.ui.quick.push(pick('mirror'), undefined);
    await s.commands.get('toMarkdown.convertFolder')(s.vscode.Uri.file(root));
    assert.strictEqual(tries(s).folder, 1);
    for (let i = 2; i <= 3; i++) { s.ui.quick.push(pick('beside')); if (i === 3) s.ui.quick.push(pick('overwrite')); await s.commands.get('toMarkdown.convertFolder')(s.vscode.Uri.file(root)); assert.strictEqual(tries(s).folder, i); }
    assert.ok(fs.existsSync(path.join(root, 'sub', 'report.md')), 'next to each file');
    const before = s.log.info.length;
    s.ui.info.push(undefined); // Cancel on the panel
    await s.commands.get('toMarkdown.convertFolder')(s.vscode.Uri.file(root));
    const panel = s.log.info[before];
    assert.strictEqual(panel.text, 'Convert a whole folder is part of Zovo Pro.');
    assert.strictEqual(panel.opts.modal, true);
    assert.deepStrictEqual(panel.buttons, CARD1);
    assert.match(panel.opts.detail, /You used the 3 free tries/);
    assert.match(panel.opts.detail, /Extract images and LLM-ready output here/);
    assert.match(panel.opts.detail, /Everything that is free today stays free\./);
    assert.strictEqual(tries(s).folder, 3);
    // the free command still works
    await s.commands.get('toMarkdown.convert')(s.vscode.Uri.file(DOCX));
    assert.match(s.log.opened.at(-1).getText(), /Project Plan/);
  } finally { s.restore(); }
});

test('Pro: Extract images writes name.md and name_assets; Escape and a file without images use no try', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    s.ui.save.push(undefined);
    await s.commands.get('toMarkdown.convertWithImages')(s.vscode.Uri.file(PPTX));
    assert.strictEqual(tries(s).images, undefined);
    const out = path.join(dir, 'out-img', 'deck.md');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    s.ui.save.push(s.vscode.Uri.file(out));
    await s.commands.get('toMarkdown.convertWithImages')(s.vscode.Uri.file(PPTX));
    assert.match(fs.readFileSync(out, 'utf8'), /!\[Chart of tickets\]\(deck_assets\/image-001\.png\)/);
    assert.deepStrictEqual([...fs.readFileSync(path.join(dir, 'out-img', 'deck_assets', 'image-001.png')).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.strictEqual(tries(s).images, 1);
    s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'out-img', 'book.md')));
    await s.commands.get('toMarkdown.convertWithImages')(s.vscode.Uri.file(XLSX));
    assert.ok(fs.existsSync(path.join(dir, 'out-img', 'book.md')));
    assert.match(s.log.info.at(-1).text, /has no images to extract.*no free try was used/);
    assert.strictEqual(tries(s).images, 1);
    for (const [i, f] of [[2, DOCX], [3, PDF]]) {
      s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'out-img', `${path.basename(f)}.md`)));
      await s.commands.get('toMarkdown.convertWithImages')(s.vscode.Uri.file(f));
      assert.strictEqual(tries(s).images, i);
    }
    s.ui.info.push(undefined);
    await s.commands.get('toMarkdown.convertWithImages')(s.vscode.Uri.file(PPTX));
    assert.strictEqual(s.log.info.at(-1).text, 'Extract images is part of Zovo Pro.');
    assert.deepStrictEqual(s.log.info.at(-1).buttons, CARD1);
  } finally { s.restore(); }
});

test('Pro: LLM-ready output as JSONL and as chunk files with front matter; Escape uses no try', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    s.ui.quick.push(undefined);
    await s.commands.get('toMarkdown.convertForLlm')(s.vscode.Uri.file(PDF));
    assert.strictEqual(tries(s).llm, undefined);
    s.ui.quick.push(pick('jsonl')); s.ui.save.push(undefined);
    await s.commands.get('toMarkdown.convertForLlm')(s.vscode.Uri.file(PDF));
    assert.strictEqual(tries(s).llm, undefined);
    const jl = path.join(dir, 'report.chunks.jsonl');
    s.ui.quick.push(pick('jsonl')); s.ui.save.push(s.vscode.Uri.file(jl));
    await s.commands.get('toMarkdown.convertForLlm')(s.vscode.Uri.file(PDF));
    const rows = fs.readFileSync(jl, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(rows.length >= 3);
    assert.strictEqual(rows[0].source, 'report.pdf');
    assert.strictEqual(rows[0].title, 'Quarterly Water Report');
    assert.deepStrictEqual(rows[1].headings, ['Quarterly Water Report', 'Summary']);
    assert.ok(rows.every((r) => r.tokens_estimate > 0 && r.text));
    assert.strictEqual(tries(s).llm, 1);
    const folder = path.join(dir, 'deck-chunks');
    s.ui.quick.push(pick('files')); s.ui.save.push(s.vscode.Uri.file(folder));
    await s.commands.get('toMarkdown.convertForLlm')(s.vscode.Uri.file(PPTX));
    const files = fs.readdirSync(folder).sort();
    assert.deepStrictEqual(files, ['001.md', '002.md', '003.md']);
    assert.match(fs.readFileSync(path.join(folder, '002.md'), 'utf8'), /^---\ntitle: "Launch Review"\nsource: "deck.pptx"\nformat: "PowerPoint presentation"\nslides: 3\nconverted: "[^"]+"\nchunk: 2\nchunks: 3\nheading: "Slide 2: What went well"\nheadings: \["Slide 2: What went well"\]\ntokens_estimate: \d+\n---\n\n## Slide 2: What went well\n/);
    assert.strictEqual(tries(s).llm, 2);
    assert.ok(s.log.status.some((t) => /3 chunks, about \d+ tokens in all \(estimate: characters \/ 4\)/.test(t)));
  } finally { s.restore(); }
});

test('package.json: Pro commands hidden by toMarkdown.showProTools, phrase-first name and description, walkthrough free of Pro words with the cross-sell step last', () => {
  assert.strictEqual(pkg.name, 'zovo-convert-to-markdown');
  assert.strictEqual(pkg.publisher, 'zovo');
  assert.ok(pkg.displayName.startsWith('Convert to Markdown'));
  assert.ok(pkg.description.startsWith('Convert to Markdown'));
  assert.strictEqual(pkg.engines.vscode, '^1.90.0');
  assert.strictEqual(pkg.devDependencies['@types/vscode'], '~1.90.0');
  assert.ok(!pkg.dependencies, 'no runtime dependencies (bundled)');
  const proIds = ['toMarkdown.convertFolder', 'toMarkdown.convertWithImages', 'toMarkdown.convertForLlm'];
  for (const [where, list] of Object.entries(pkg.contributes.menus)) for (const m of list) if (proIds.includes(m.command)) assert.match(m.when, /config\.toMarkdown\.showProTools/, `${where} ${m.command}`);
  for (const id of proIds) assert.ok(pkg.contributes.menus.commandPalette.some((m) => m.command === id));
  const steps = pkg.contributes.walkthroughs[0].steps;
  assert.strictEqual(steps.at(-1).id, 'zovo-related');
  for (const st of steps) assert.ok(!/\bPro\b|USD|Sponsor|PayPal|price/i.test(st.title + st.description), st.id);
  for (const f of ['samples/sample-plan.docx', 'samples/sample-report.pdf', 'samples/sample-slides.pptx', 'walkthrough/convert.md', 'walkthrough/slides.md', 'walkthrough/copy.md', 'icon.png', 'LICENSE', 'THIRD-PARTY-NOTICES.txt']) assert.ok(fs.existsSync(path.join(__dirname, '..', f)), f);
  const ignore = fs.readFileSync(path.join(__dirname, '..', '.vscodeignore'), 'utf8');
  for (const p of ['test/**', 'scripts/**', 'node_modules/**']) assert.ok(ignore.includes(p), p);
});

test('a walkthrough sample converts and does not count for the rating ask', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    await s.commands.get('toMarkdown.convertSample')('pptx');
    const d = s.log.opened.at(-1);
    assert.strictEqual(d.uri.toString(), 'untitled:doc', 'no path inside the extension folder');
    assert.match(d.getText(), /## Slide 1: Launch Review/);
    assert.ok(!s.state.has('zovo.rating.v2') || !(s.state.get('zovo.rating.v2').count > 0));
  } finally { s.restore(); }
});
