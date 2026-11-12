'use strict';
// Zovo Pro for Convert to Markdown, on top of the shared license module (src/license, copied unchanged from
// factory/sprint/license). Three Pro tools, 3 free tries each on this computer. A try counts only after the tool
// produced its output (Markdown files written to disk); Escape or Cancel never uses one.
// Nothing about Pro shows on open or activation: the panel appears only after a click on a Pro tool with no tries left.
const { createLicense } = require('./license');
const { withSurface } = require('./reach');

const SKU = 'tomd-pro';
const TRIAL_USES = 3;
const TRIAL_KEY = 'toMarkdown.proTrial';

const FEATURES = {
  folder: {
    title: 'Convert a whole folder',
    detail: 'Converts every PDF, Word, PowerPoint, Excel, CSV, HTML, EPUB, ODT and RTF file in a folder and its subfolders to a mirrored tree of .md files, with progress, cancel, a skip-or-overwrite choice and a summary report.',
  },
  images: {
    title: 'Extract images',
    detail: 'Saves the images of DOCX, PPTX, PDF, ODT and EPUB files to an assets folder next to the .md file and links them with relative paths, so the Markdown shows them.',
  },
  llm: {
    title: 'LLM-ready output',
    detail: 'Adds YAML front matter (title, source file, pages or slides, date) and splits the Markdown into chunks by heading with a token estimate for each, saved as one file per chunk or as one JSONL file.',
  },
};
const TOOLS = Object.values(FEATURES).map((f) => f.title);

function createPro({ vscode, context, license, prefix = 'toMarkdown', productName = 'Convert to Markdown', licenseOptions = {} }) {
  const emitter = new vscode.EventEmitter();
  const lic = license || createLicense({ vscode, context, sku: SKU, name: 'Zovo', product: productName, commandPrefix: prefix, proTools: TOOLS, ...licenseOptions });
  if (lic.onDidChange) lic.onDidChange(() => emitter.fire(lic.isPro(SKU)));

  const used = (f) => Number((context.globalState.get(TRIAL_KEY) || {})[f]) || 0;
  const left = (f) => (FEATURES[f] ? Math.max(0, TRIAL_USES - used(f)) : 0);
  const licensed = () => lic.isPro(SKU);

  /** Before a Pro tool runs: true when it may run (licensed, or a free try left). Otherwise the one panel. */
  async function allowed(f) {
    if (licensed()) { if (lic.refresh) lic.refresh(); return true; }
    if (left(f) > 0) return true;
    const feat = FEATURES[f] || { title: 'This tool', detail: '' };
    return !!(await lic.requirePro(feat.title, withSurface({ detail: feat.detail, triesUsed: used(f), tools: TOOLS })));
  }

  /**
   * After the tool produced its output: counts one free try (nothing when licensed). `done` is the tool's own status
   * text; the status bar shows it together with the try count, so neither message hides the other.
   */
  async function produced(f, done = '') {
    if (licensed() || !FEATURES[f]) return;
    const m = { ...(context.globalState.get(TRIAL_KEY) || {}) };
    m[f] = used(f) + 1;
    await context.globalState.update(TRIAL_KEY, m);
    const l = left(f);
    vscode.window.setStatusBarMessage(`${done ? `${done} ` : ''}Zovo Pro: free try ${used(f)} of ${TRIAL_USES} of "${FEATURES[f].title}" used${l ? `, ${l} left` : ''} on this computer.`, 10000);
    emitter.fire(false);
  }

  context.subscriptions.push(emitter);
  return {
    SKU, FEATURES, TRIAL_USES,
    get licensed() { return licensed(); },
    ready: lic.ready,
    allowed, produced, left,
    tries: () => Object.fromEntries(Object.keys(FEATURES).map((f) => [f, left(f)])),
    handleUri: (uri) => (lic.handleUri ? lic.handleUri(uri) : undefined),
    onDidChange: emitter.event,
    license: lic,
  };
}

module.exports = { createPro, FEATURES, SKU, TRIAL_USES, TRIAL_KEY, TOOLS };
