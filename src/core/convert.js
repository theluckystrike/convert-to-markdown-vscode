'use strict';
// One entry point for every format: detect the kind from the bytes, run its converter, return the Markdown with the
// title, headings, page/slide/sheet counts, notes and (Extract images) the image files.
const { detect, REFUSALS } = require('./detect');
const { Assets } = require('./assets');

const CONVERTERS = {
  pdf: () => require('./pdf').pdf,
  docx: () => require('./office').docx,
  doc: () => require('./office').doc,
  rtf: () => require('./office').rtf,
  odt: () => require('./office').odt,
  html: () => require('./office').html,
  epub: () => require('./office').epub,
  pptx: () => require('./pptx').pptx,
  xlsx: () => require('./sheets').workbook,
  xls: () => require('./sheets').workbook,
  ods: () => require('./sheets').workbook,
  csv: () => require('./sheets').csv,
  tsv: () => require('./sheets').tsv,
};

function refused(msg) { const e = new Error(msg); e.code = 'REFUSED'; return e; }

/**
 * buf: Buffer/Uint8Array. opts: { name, images: 'placeholder'|'collect', assetsDir, limits, pdfjs, progress, checkCancel }
 */
async function convert(buf, opts = {}) {
  const d = detect(buf, opts.name);
  if (!CONVERTERS[d.kind]) throw refused(REFUSALS[d.kind] || REFUSALS.unknown);
  const assets = new Assets(opts.images === 'collect' ? 'collect' : 'placeholder', opts.assetsDir || 'assets');
  const ctx = { assets, limits: opts.limits || {}, pdfjs: opts.pdfjs, progress: opts.progress || (() => {}), checkCancel: opts.checkCancel || (() => {}) };
  let r;
  try {
    r = await CONVERTERS[d.kind]()(buf, ctx);
  } catch (e) {
    if (e && e.code) throw e;
    const err = new Error(`${String((e && e.message) || e).slice(0, 300)}`);
    err.code = 'CONVERT';
    throw err;
  }
  return {
    kind: d.kind,
    markdown: r.markdown,
    title: r.title || '',
    headings: r.headings || [],
    meta: r.meta || {},
    notes: (r.notes || []).concat(assets.skipped ? [`${assets.skipped} images were not saved (more than 2,000 images or 512 MB).`] : []),
    images: assets.files,
    imageCount: assets.count,
  };
}

module.exports = { convert, CONVERTERS };
