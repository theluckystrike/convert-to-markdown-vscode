'use strict';
// Convert to Markdown: PDF, Word, PowerPoint, Excel, CSV, HTML, EPUB, ODT and RTF files to Markdown, inside VS Code.
// Nothing to install and nothing leaves the computer: every converter is bundled and runs in a worker thread
// (runner.js) with a memory cap, a watchdog and Cancel, so a hostile or huge file cannot block the editor.
// Zovo Pro tools (pro.js) ask only when they are used; nothing about Pro shows on open or activation.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { runJob } = require('./runner');
const { EXT_RE, EXTENSIONS } = require('./core/detect');
const llm = require('./core/llm');
const { createPro } = require('./pro');
const { createRatingPrompt } = require('./rate');
const { registerSupport } = require('./support');

const EXT_ID = 'zovo.zovo-convert-to-markdown';
const PREFIX = 'toMarkdown';
const MAX_REMOTE_BYTES = 256 * 1024 * 1024;
const MAX_UNTITLED_CHARS = 20 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', '.tox', '.cache', '.vscode-test']);
const IMAGE_KINDS = /\.(docx|docm|dotx|dotm|pptx|pptm|ppsx|potx|pdf|odt|ott|epub|html?|xhtml)$/i;

let rating = { success() {}, failure() {} };
let pro;
let extensionUri;

function setting(key, dflt) { try { const v = vscode.workspace.getConfiguration(PREFIX).get(key, dflt); return v === undefined ? dflt : v; } catch { return dflt; } }
const baseName = (uri) => path.posix.basename(uri.path) || uri.toString();
const stemOf = (name) => name.replace(/\.[^.]+$/, '') || name;
const mb = (n) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
const isSample = (uri) => !!extensionUri && uri.scheme === 'file' && uri.fsPath.startsWith(extensionUri.fsPath + path.sep);

// ---------------- which file ----------------

function activeUri() {
  try {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const inp = tab && tab.input;
    const u = inp && (inp.uri || inp.modified);
    if (u && EXT_RE.test(u.path)) return u;
  } catch { /* older API */ }
  const ed = vscode.window.activeTextEditor;
  if (ed && EXT_RE.test(ed.document.uri.path)) return ed.document.uri;
  return null;
}

async function pickFile(title) {
  const p = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Convert', title, filters: { 'Documents, slides, sheets, web pages, books': EXTENSIONS, 'All files': ['*'] } });
  return p && p[0] ? p[0] : null;
}

async function targetOf(arg, title) {
  if (arg && arg.scheme) return arg;
  return activeUri() || pickFile(title);
}

// ---------------- converting ----------------

/** Runs one conversion in the worker. Throws with e.code (REFUSED, TOO_BIG, CANCELLED, TIMEOUT, MEMORY, ...). */
async function convertUri(uri, { images = 'placeholder', assetsDir, token, onProgress } = {}) {
  const maxBytes = Math.max(1, Number(setting('maxFileSizeMB', 200)) || 200) * 1048576;
  const limits = { maxPages: Math.max(1, Number(setting('pdfMaxPages', 1000)) || 1000) };
  const job = { op: 'convert', name: baseName(uri), images, assetsDir, limits, maxBytes };
  if (uri.scheme === 'file') return runJob({ ...job, file: uri.fsPath }, { token, onProgress });
  const st = await vscode.workspace.fs.stat(uri);
  if (st.size > Math.min(maxBytes, MAX_REMOTE_BYTES)) { const e = new Error('TOO_BIG'); e.code = 'TOO_BIG'; e.size = st.size; throw e; }
  const data = await vscode.workspace.fs.readFile(uri);
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return runJob({ ...job, buffer: buf }, { token, onProgress, transfer: [buf] });
}

/** The same with a progress notification and a Cancel button. Returns the result or null (message shown). */
async function convertWithProgress(uri, opts = {}) {
  const name = baseName(uri);
  try {
    return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Converting ${name} to Markdown`, cancellable: true },
      (progress, token) => convertUri(uri, { ...opts, token, onProgress: (p) => progress.report({ message: p.message }) }));
  } catch (e) {
    showFailure(name, e);
    return null;
  }
}

function failureText(name, e) {
  switch (e && e.code) {
    case 'TOO_BIG': return `${name} is ${mb(e.size || 0)}. Files up to ${setting('maxFileSizeMB', 200)} MB are converted (setting toMarkdown.maxFileSizeMB).`;
    case 'REFUSED': return `${name}: ${e.message}`;
    case 'CANCELLED': return '';
    case 'TIMEOUT': case 'MEMORY': return `${name} could not be converted: ${e.message}`;
    default: return `${name} could not be converted: ${String((e && e.message) || e).slice(0, 300)}`;
  }
}

function showFailure(name, e) {
  const code = e && e.code;
  if (code === 'CANCELLED') { vscode.window.setStatusBarMessage(`Converting ${name} was cancelled.`, 5000); return; }
  const text = failureText(name, e);
  if (code === 'REFUSED' || code === 'TOO_BIG') vscode.window.showWarningMessage(text);
  else { rating.failure(); vscode.window.showErrorMessage(text); }
}

function showNotes(name, r) {
  if (r.notes && r.notes.length) vscode.window.showInformationMessage(`${name}: ${r.notes.join(' ')}`);
}

async function uniqueUntitled(dirUri, stem) {
  const open = new Set(vscode.workspace.textDocuments.map((d) => d.uri.toString()));
  for (let i = 1; i < 1000; i++) {
    const n = i === 1 ? `${stem}.md` : `${stem} (${i}).md`;
    const u = vscode.Uri.joinPath(dirUri, n).with({ scheme: 'untitled' });
    if (!open.has(u.toString())) return u;
  }
  return null;
}

async function exists(uri) { try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; } }

/** Free: show the Markdown beside the source, as an unsaved document (default) or a saved .md file next to it. */
async function showMarkdown(uri, r) {
  const name = baseName(uri);
  const dir = vscode.Uri.joinPath(uri, '..');
  let mode = setting('output', 'untitled');
  if (mode !== 'file' && r.markdown.length > MAX_UNTITLED_CHARS && uri.scheme === 'file') mode = 'file';
  let doc;
  if (mode === 'file' && uri.scheme === 'file' && !isSample(uri)) {
    let target = vscode.Uri.joinPath(dir, `${stemOf(name)}.md`);
    if (await exists(target)) {
      const pick = await vscode.window.showWarningMessage(`${stemOf(name)}.md already exists next to ${name}.`, { modal: true }, 'Replace', 'Keep both');
      if (!pick) return null;
      if (pick === 'Keep both') for (let i = 2; i < 1000 && (await exists(target)); i++) target = vscode.Uri.joinPath(dir, `${stemOf(name)} (${i}).md`);
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(r.markdown, 'utf8'));
    doc = await vscode.workspace.openTextDocument(target);
  } else {
    const u = uri.scheme === 'file' && !isSample(uri) ? await uniqueUntitled(dir, stemOf(name)) : null;
    if (u) {
      doc = await vscode.workspace.openTextDocument(u);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(u, new vscode.Position(0, 0), r.markdown);
      await vscode.workspace.applyEdit(edit);
      if (doc.languageId !== 'markdown') doc = await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
    } else {
      doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: r.markdown });
    }
  }
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  return doc;
}

async function convertCommand(arg, all) {
  const list = Array.isArray(all) && all.length > 1 ? all.filter((u) => u && u.scheme && EXT_RE.test(u.path)).slice(0, 20) : [await targetOf(arg, 'Convert to Markdown')];
  for (const uri of list) {
    if (!uri) return;
    const r = await convertWithProgress(uri);
    if (!r) continue;
    const doc = await showMarkdown(uri, r);
    if (!doc) continue;
    vscode.window.setStatusBarMessage(`Converted ${baseName(uri)} to Markdown: ${summary(r)}.`, 8000);
    showNotes(baseName(uri), r);
    if (isSample(uri)) rating.success({ sample: true }); else rating.success(uri);
  }
}

function summary(r) {
  const m = r.meta || {};
  const parts = [];
  if (m.pages) parts.push(`${m.pages} page${m.pages === 1 ? '' : 's'}`);
  if (m.slides) parts.push(`${m.slides} slide${m.slides === 1 ? '' : 's'}`);
  if (m.sheets) parts.push(`${m.sheets} sheet${m.sheets === 1 ? '' : 's'}`);
  if (m.chapters) parts.push(`${m.chapters} chapter${m.chapters === 1 ? '' : 's'}`);
  parts.push(`${r.markdown.length.toLocaleString('en-US')} characters`);
  return parts.join(', ');
}

async function copyCommand(arg) {
  const uri = await targetOf(arg, 'Copy as Markdown');
  if (!uri) return;
  const r = await convertWithProgress(uri);
  if (!r) return;
  await vscode.env.clipboard.writeText(r.markdown);
  vscode.window.setStatusBarMessage(`Copied ${baseName(uri)} as Markdown (${r.markdown.length.toLocaleString('en-US')} characters).`, 8000);
  showNotes(baseName(uri), r);
  if (isSample(uri)) rating.success({ sample: true }); else rating.success(uri);
}

// ---------------- Zovo Pro 1: a whole folder ----------------

async function listSources(root, skipUnder, cancelled) {
  const out = [];
  let seen = 0;
  const stack = [[root, 0]];
  while (stack.length && seen < 50000 && out.length < 10000 && !cancelled()) {
    const [dir, depth] = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (++seen > 50000) break;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.') && depth < 32 && p !== skipUnder) stack.push([p, depth + 1]); continue; }
      if (e.isFile() && EXT_RE.test(e.name) && !e.name.startsWith('~$')) out.push(p);
    }
  }
  return out.sort();
}

async function folderCommand(arg) {
  if (!(await pro.allowed('folder'))) return;
  let root = arg && arg.scheme === 'file' ? arg.fsPath : null;
  if (root && !(await fs.promises.stat(root).then((s) => s.isDirectory(), () => false))) root = path.dirname(root);
  if (!root) {
    const p = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, openLabel: 'Convert this folder', title: 'Convert a whole folder to Markdown' });
    if (!p || !p[0]) return; // Escape: no try used
    root = p[0].fsPath;
  }
  const name = path.basename(root);
  const sibling = path.join(path.dirname(root), `${name}-markdown`);
  const where = await vscode.window.showQuickPick([
    { label: `Into a new folder: ${name}-markdown`, description: 'next to the folder, same subfolders', id: 'mirror' },
    { label: 'Next to each file', description: 'a .md beside every source file', id: 'beside' },
    { label: 'Pick another folder...', id: 'pick' },
  ], { title: `Convert every supported file in ${name}: where do the .md files go?` });
  if (!where) return;
  let outRoot = where.id === 'mirror' ? sibling : root;
  if (where.id === 'pick') {
    const p = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, openLabel: 'Write the .md files here', title: 'Output folder' });
    if (!p || !p[0]) return;
    outRoot = p[0].fsPath;
  }
  const files = await listSources(root, outRoot === root ? null : outRoot, () => false);
  if (!files.length) { vscode.window.showInformationMessage(`No PDF, Word, PowerPoint, Excel, CSV, HTML, EPUB, ODT or RTF files in ${name}. No free try was used.`); return; }
  const targetOfFile = (f) => path.join(outRoot, path.relative(root, path.dirname(f)), `${stemOf(path.basename(f))}.md`);
  const existing = files.filter((f) => fs.existsSync(targetOfFile(f))).length;
  let overwrite = false;
  if (existing) {
    const p = await vscode.window.showQuickPick([
      { label: `Skip the ${existing} file${existing === 1 ? '' : 's'} that already have a .md`, id: 'skip' },
      { label: `Overwrite the ${existing} existing .md file${existing === 1 ? '' : 's'}`, id: 'overwrite' },
    ], { title: `${existing} of ${files.length} .md files already exist` });
    if (!p) return;
    overwrite = p.id === 'overwrite';
  }
  const rows = [];
  const started = Date.now();
  let stopped = false;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Converting ${files.length} files in ${name}`, cancellable: true }, async (progress, token) => {
    for (let i = 0; i < files.length; i++) {
      if (token.isCancellationRequested) { stopped = true; break; }
      const f = files[i];
      const rel = path.relative(root, f);
      const out = targetOfFile(f);
      progress.report({ message: `${i + 1} of ${files.length}: ${rel}`, increment: 100 / files.length });
      if (!overwrite && fs.existsSync(out)) { rows.push({ rel, status: 'skipped', note: '.md exists' }); continue; }
      try {
        const r = await convertUri(vscode.Uri.file(f), { token });
        await fs.promises.mkdir(path.dirname(out), { recursive: true });
        await fs.promises.writeFile(out, r.markdown, 'utf8');
        rows.push({ rel, status: 'converted', out: path.relative(outRoot, out), note: [summary(r), ...(r.notes || [])].join('; ') });
      } catch (e) {
        if (e && e.code === 'CANCELLED') { stopped = true; break; }
        rows.push({ rel, status: 'failed', note: failureText(path.basename(f), e).replace(/^[^:]*: /, '') });
      }
    }
  });
  const n = (s) => rows.filter((r) => r.status === s).length;
  const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/[<>[\]]/g, (c) => `\\${c}`);
  const report = [
    `# Conversion report: ${esc(name)}`,
    '',
    `- Source: \`${root}\``,
    `- Output: \`${outRoot}\``,
    `- Converted: ${n('converted')}, skipped: ${n('skipped')}, failed: ${n('failed')}${stopped ? `, not started: ${files.length - rows.length} (stopped)` : ''}`,
    `- Time: ${((Date.now() - started) / 1000).toFixed(1)} s, ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    '',
    '| File | Result | Markdown | Notes |',
    '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${esc(r.rel)} | ${r.status} | ${r.out ? `[${esc(r.out)}](<${r.out.split(path.sep).join('/')}>)` : ''} | ${esc(r.note || '')} |`),
    '',
  ].join('\n');
  const reportPath = path.join(outRoot, '_conversion-report.md');
  await fs.promises.mkdir(outRoot, { recursive: true });
  await fs.promises.writeFile(reportPath, report, 'utf8');
  await vscode.window.showTextDocument(vscode.Uri.file(reportPath), { preview: false });
  if (n('converted')) { await pro.produced('folder'); rating.success(vscode.Uri.file(reportPath)); }
  vscode.window.setStatusBarMessage(`Converted ${n('converted')} of ${files.length} files to Markdown${stopped ? ' (stopped)' : ''}.`, 8000);
}

// ---------------- Zovo Pro 2: extract images ----------------

async function imagesCommand(arg) {
  if (!(await pro.allowed('images'))) return;
  const uri = await targetOf(arg, 'Convert to Markdown with images');
  if (!uri) return;
  if (uri.scheme !== 'file') { vscode.window.showWarningMessage('Extract images needs a file on this computer.'); return; }
  const name = baseName(uri);
  const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(path.dirname(uri.fsPath), `${stemOf(name)}.md`)), filters: { Markdown: ['md'] }, title: `Save ${name} as Markdown with its images` });
  if (!target) return; // Escape: no try used
  const mdPath = target.fsPath.endsWith('.md') ? target.fsPath : `${target.fsPath}.md`;
  const assetsDir = `${stemOf(path.basename(mdPath))}_assets`;
  const r = await convertWithProgress(uri, { images: 'collect', assetsDir });
  if (!r) return;
  const dir = path.join(path.dirname(mdPath), assetsDir);
  if (r.images.length) {
    await fs.promises.mkdir(dir, { recursive: true });
    for (const im of r.images) await fs.promises.writeFile(path.join(dir, im.name), Buffer.from(im.data));
  }
  await fs.promises.writeFile(mdPath, r.markdown, 'utf8');
  await vscode.window.showTextDocument(vscode.Uri.file(mdPath), { viewColumn: vscode.ViewColumn.Beside, preview: false });
  if (r.images.length) {
    await pro.produced('images');
    vscode.window.setStatusBarMessage(`Saved ${path.basename(mdPath)} and ${r.images.length} image${r.images.length === 1 ? '' : 's'} in ${assetsDir}.`, 8000);
  } else {
    vscode.window.showInformationMessage(`${name} has no images to extract. The Markdown was saved; no free try was used.`);
  }
  showNotes(name, r);
  rating.success(uri);
}

// ---------------- Zovo Pro 3: LLM-ready chunks ----------------

async function llmCommand(arg) {
  if (!(await pro.allowed('llm'))) return;
  const uri = await targetOf(arg, 'Convert to LLM-ready Markdown');
  if (!uri) return;
  const name = baseName(uri);
  const kind = await vscode.window.showQuickPick([
    { label: 'One JSONL file', description: 'one chunk per line: text, heading, token estimate, source', id: 'jsonl' },
    { label: 'One Markdown file per chunk', description: 'each with YAML front matter', id: 'files' },
  ], { title: `LLM-ready output for ${name}: split into chunks by heading` });
  if (!kind) return; // Escape: no try used
  const dir = uri.scheme === 'file' ? path.dirname(uri.fsPath) : (vscode.workspace.workspaceFolders || [])[0]?.uri.fsPath;
  const target = await vscode.window.showSaveDialog({
    defaultUri: dir ? vscode.Uri.file(path.join(dir, kind.id === 'jsonl' ? `${stemOf(name)}.chunks.jsonl` : `${stemOf(name)}-chunks`)) : undefined,
    filters: kind.id === 'jsonl' ? { JSONL: ['jsonl'] } : undefined,
    title: kind.id === 'jsonl' ? 'Save the chunks as JSONL' : 'Folder for the chunk files (created if needed)',
  });
  if (!target) return;
  const r = await convertWithProgress(uri);
  if (!r) return;
  const m = r.meta || {};
  const fields = { title: r.title || stemOf(name), source: name, format: m.format, pages: m.pages, slides: m.slides, sheets: m.sheets, chapters: m.chapters, converted: new Date().toISOString() };
  const chunks = llm.chunk(r.markdown, { maxTokens: Math.max(100, Number(setting('llmChunkTokens', 800)) || 800) });
  if (!chunks.length) { vscode.window.showInformationMessage(`${name} has no text to split. No free try was used.`); return; }
  const tokens = chunks.reduce((n, c) => n + c.tokens, 0);
  let open;
  if (kind.id === 'jsonl') {
    await fs.promises.writeFile(target.fsPath, llm.toJsonl(chunks, fields), 'utf8');
    open = target;
  } else {
    await fs.promises.mkdir(target.fsPath, { recursive: true });
    const files = llm.chunkFiles(chunks, fields);
    for (const f of files) await fs.promises.writeFile(path.join(target.fsPath, f.name), f.text, 'utf8');
    open = vscode.Uri.file(path.join(target.fsPath, files[0].name));
  }
  await vscode.window.showTextDocument(open, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  await pro.produced('llm');
  vscode.window.setStatusBarMessage(`${chunks.length} chunk${chunks.length === 1 ? '' : 's'}, about ${tokens.toLocaleString('en-US')} tokens in all (estimate: characters / 4).`, 10000);
  rating.success(uri);
}

// ---------------- activation ----------------

function activate(context) {
  extensionUri = context.extensionUri;
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: 'Convert to Markdown' });
  registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  pro = createPro({ vscode, context });
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg(`${PREFIX}.convert`, (uri, all) => convertCommand(uri, all));
  reg(`${PREFIX}.copyAsMarkdown`, (uri) => copyCommand(uri));
  reg(`${PREFIX}.convertFolder`, (uri) => folderCommand(uri));
  reg(`${PREFIX}.convertWithImages`, (uri) => imagesCommand(uri));
  reg(`${PREFIX}.convertForLlm`, (uri) => llmCommand(uri));
  reg(`${PREFIX}.convertSample`, async (which) => {
    const n = { pdf: 'sample-report.pdf', pptx: 'sample-slides.pptx' }[which] || 'sample-plan.docx';
    await convertCommand(vscode.Uri.joinPath(context.extensionUri, 'samples', n));
  });
  reg(`${PREFIX}.openWalkthrough`, () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#toMarkdown.start`, false));
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: (uri) => pro.handleUri(uri) }));
}

function deactivate() {}

module.exports = { activate, deactivate, listSources, IMAGE_KINDS };
