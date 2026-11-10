'use strict';
// A small stand-in for the vscode module: enough for activation, the commands, the Pro tools and the license
// facade. Tests script the dialogs through `ui` and read what happened from `log`.
const fs = require('fs');
const path = require('path');
const Module = require('module');

function create() {
  const log = { info: [], warn: [], error: [], status: [], opened: [], external: [], commands: [], posted: [], saved: [], progress: [] };
  const ui = { open: [], save: [], input: [], quick: [], info: [], warn: [] };
  const commands = new Map();
  const providers = new Map();
  const state = new Map();
  const config = { showProTools: true, showSupportLinks: true, askForRating: false, output: 'untitled' };
  const docs = [];
  class EventEmitter { constructor() { this.l = new Set(); this.event = (f) => { this.l.add(f); return { dispose: () => this.l.delete(f) }; }; } fire(v) { for (const f of this.l) f(v); } dispose() { this.l.clear(); } }
  class Uri {
    constructor(scheme, p) { this.scheme = scheme; this.path = p; this.fsPath = p; }
    static file(p) { return new Uri('file', path.resolve(p)); }
    static parse(s) { const u = new Uri(s.split(':')[0], s); u.str = s; return u; }
    static joinPath(u, ...parts) { return new Uri(u.scheme, path.join(u.path, ...parts)); }
    toString() { return this.str || `${this.scheme}://${this.path}`; }
    with(o) { const u = new Uri(o && o.scheme || this.scheme, this.path); return u; }
  }
  const nextOf = (q, dflt) => (q.length ? q.shift() : dflt);
  const msg = (kind) => async (text, ...rest) => {
    const opts = rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0]) ? rest.shift() : {};
    log[kind].push({ text, opts, buttons: rest.map((b) => (typeof b === 'string' ? b : b.title)) });
    return kind === 'info' || kind === 'warn' ? nextOf(ui[kind], undefined) : undefined;
  };
  const vscode = {
    version: '1.90.2',
    EventEmitter, Uri,
    ViewColumn: { Beside: -2, Active: -1, One: 1 },
    ProgressLocation: { Notification: 15, Window: 10 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    env: { appName: 'Visual Studio Code', uriScheme: 'vscode', machineId: 'test', clipboard: { writeText: async (t) => { log.clipboard = t; } }, openExternal: async (u) => { log.external.push(String(u)); return true; }, asExternalUri: async (u) => u },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: () => ({ get: (k, d) => (k in config ? config[k] : d), update: async () => {} }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      fs: {
        stat: async (u) => ({ size: fs.statSync(u.fsPath).size }),
        readFile: async (u) => fs.readFileSync(u.fsPath),
        writeFile: async (u, b) => { fs.writeFileSync(u.fsPath, b); log.saved.push(u.fsPath); },
      },
      openTextDocument: async (o) => {
        if (o instanceof Uri) {
          const d = { uri: o, languageId: /\.md$/.test(o.path) ? 'markdown' : 'plaintext', text: o.scheme === 'file' && fs.existsSync(o.fsPath) ? fs.readFileSync(o.fsPath, 'utf8') : '', getText() { return this.text; } };
          docs.push(d); return d;
        }
        const d = { uri: Uri.parse('untitled:doc'), languageId: (o && o.language) || 'plaintext', text: (o && o.content) || '', getText() { return this.text; } };
        docs.push(d); return d;
      },
      get textDocuments() { return docs; },
      applyEdit: async (e) => { for (const [u, t] of e.ops) { const d = docs.find((x) => x.uri.toString() === u.toString()); if (d) d.text = t + d.text; } return true; },
      isTrusted: true,
    },
    WorkspaceEdit: class { constructor() { this.ops = []; } insert(u, p, t) { this.ops.push([u, t]); } },
    Position: class { constructor(l, c) { this.line = l; this.character = c; } },
    languages: { setTextDocumentLanguage: async (d, l) => { d.languageId = l; return d; } },
    window: {
      activeTextEditor: undefined,
      tabGroups: { activeTabGroup: { activeTab: undefined } },
      state: { focused: true },
      onDidChangeWindowState: () => ({ dispose() {} }),
      registerCustomEditorProvider: (vt, p) => { providers.set(vt, p); return { dispose() {} }; },
      registerUriHandler: () => ({ dispose() {} }),
      showInformationMessage: msg('info'), showWarningMessage: msg('warn'), showErrorMessage: msg('error'),
      setStatusBarMessage: (t) => { log.status.push(t); return { dispose() {} }; },
      showOpenDialog: async () => nextOf(ui.open, undefined),
      showSaveDialog: async () => nextOf(ui.save, undefined),
      showInputBox: async (o) => { const v = nextOf(ui.input, undefined); if (v !== undefined && o && o.validateInput) { const e = o.validateInput(v); if (e) throw new Error(e); } return v; },
      showQuickPick: async (items) => { const f = nextOf(ui.quick, undefined); return typeof f === 'function' ? f(await items) : f; },
      showTextDocument: async (d) => { log.opened.push(d); return {}; },
      withProgress: async (o, fn) => { log.progress.push(o.title); const tok = { isCancellationRequested: false, onCancellationRequested: (f) => { tok.cb = f; return { dispose() {} }; } }; ui.lastToken = tok; return fn({ report: (r) => log.progress.push(r.message) }, tok); },
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    },
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
      executeCommand: async (id, ...a) => { log.commands.push([id, ...a]); if (commands.has(id)) return commands.get(id)(...a); return undefined; },
    },
    extensions: { all: [], getExtension: () => undefined, onDidChange: () => ({ dispose() {} }) },
    authentication: { getSession: async () => undefined, onDidChangeSessions: () => ({ dispose() {} }) },
    l10n: { t: (s) => s },
  };
  const secrets = new Map();
  const context = {
    subscriptions: [],
    extensionUri: Uri.file(path.join(__dirname, '..', '..')),
    extensionPath: path.join(__dirname, '..', '..'),
    extension: undefined,
    globalStorageUri: Uri.file(fs.mkdtempSync(path.join(require('os').tmpdir(), 'tomd-gs-'))),
    globalState: { get: (k, d) => (state.has(k) ? state.get(k) : d), update: async (k, v) => { state.set(k, v); }, keys: () => [...state.keys()], setKeysForSync() {} },
    secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); }, onDidChange: () => ({ dispose() {} }) },
  };
  return { vscode, context, log, ui, commands, providers, state, config };
}

/** Load src/extension.js with a fresh stub; returns the stub and the module. */
function loadExtension() {
  const stub = create();
  const orig = Module._load;
  Module._load = function (req, parent, isMain) { if (req === 'vscode') return stub.vscode; return orig.call(this, req, parent, isMain); };
  const root = path.join(__dirname, '..', '..', 'src');
  for (const k of Object.keys(require.cache)) if (k.startsWith(root)) delete require.cache[k];
  try { stub.ext = require(path.join(root, 'extension.js')); } finally { Module._load = orig; }
  // later requires of vscode (lazy ones) still need the stub
  Module._load = function (req, parent, isMain) { if (req === 'vscode') return stub.vscode; return orig.call(this, req, parent, isMain); };
  stub.restore = () => { Module._load = orig; };
  return stub;
}

module.exports = { create, loadExtension };
