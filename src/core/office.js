'use strict';
// Word (.docx/.docm/.dotx), old Word (.doc), RTF, OpenDocument text (.odt), HTML and EPUB to Markdown.
// Every format becomes HTML first (mammoth for .docx, the DOCX Viewer readers for .odt, .doc and RTF), then one
// HTML-to-Markdown writer (html2md.js) makes the Markdown, so all formats get the same headings, lists and tables.
const path = require('path');
const { htmlToMarkdown } = require('./html2md');
const M = require('./md');

const STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => p:fresh",
  "p[style-name='Quote'] => blockquote > p:fresh",
  "p[style-name='Intense Quote'] => blockquote > p:fresh",
  "p[style-name='Code'] => pre:separator('\\n')",
  "r[style-name='Strong'] => strong",
  'strike => del',
  'u => u',
];

/** html2md image hook for the "asset:N" tokens and data: URIs. */
function imageHook(assets, tokens) {
  return (src, alt) => {
    const m = /^asset:(\d+)$/.exec(src || '');
    if (m) { const t = tokens[Number(m[1])]; return assets.add(t ? t.bytes : null, alt, t && t.ext); }
    if (/^data:/i.test(src || '')) return assets.addDataUri(src, alt);
    if (!src) return assets.placeholder(alt);
    return null;
  };
}

function coreTitle(buf) {
  try {
    const { unzipSync, strFromU8 } = require('fflate');
    const f = unzipSync(buf instanceof Uint8Array ? buf : new Uint8Array(buf), { filter: (x) => x.name === 'docProps/core.xml' && x.originalSize < 1 << 20 });
    const xml = f['docProps/core.xml'] ? strFromU8(f['docProps/core.xml']) : '';
    const t = /<dc:title>([^<]{1,300})<\/dc:title>/.exec(xml);
    return t ? t[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : '';
  } catch { return ''; }
}

async function docx(buf, ctx) {
  const mammoth = require('mammoth');
  const tokens = [];
  const convertImage = mammoth.images.imgElement(async (image) => {
    if (!ctx.assets.collecting) { tokens.push(null); return { src: `asset:${tokens.length - 1}` }; }
    const bytes = await image.read();
    tokens.push({ bytes, ext: String(image.contentType || '').split('/')[1] });
    return { src: `asset:${tokens.length - 1}` };
  });
  ctx.progress('Reading the Word document');
  const r = await mammoth.convertToHtml({ buffer: Buffer.from(buf) }, { styleMap: STYLE_MAP, convertImage, includeDefaultStyleMap: true, ignoreEmptyParagraphs: true });
  ctx.progress('Writing Markdown');
  const out = htmlToMarkdown(r.value, { image: imageHook(ctx.assets, tokens) });
  return { markdown: out.markdown, title: coreTitle(buf) || out.title, headings: out.headings, meta: { format: 'Word document' } };
}

async function doc(buf, ctx) {
  const { extractDoc, docToHtml } = require('./doc');
  ctx.progress('Reading the old Word file');
  let d;
  try { d = await extractDoc(Buffer.from(buf)); } catch (e) {
    if (e && e.code === 'DV_ENCRYPTED') { const err = new Error('This Word file is password-protected. Remove the password in Word and convert it again.'); err.code = 'REFUSED'; throw err; }
    throw e;
  }
  const { html } = docToHtml(d);
  const out = htmlToMarkdown(html, {});
  return { markdown: out.markdown, title: out.title, headings: out.headings, meta: { format: 'Word 97-2003 document (text only)' }, notes: ['Old Word 97-2003 file: the text and tables are converted; formatting and images are not.'] };
}

function textToMarkdown(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let rows = null;
  const flush = () => { if (rows) { out.push(M.table(rows)); rows = null; } };
  for (const line of lines) {
    if (/\t$/.test(line) && line.trim()) { const cells = line.split('\t'); cells.pop(); (rows || (rows = [])).push(cells.map((c) => c.trim())); continue; }
    flush();
    const t = line.trim();
    if (t) out.push(M.escapeLine(t));
  }
  flush();
  return M.tidy(out.join('\n\n'));
}

async function rtf(buf, ctx) {
  const { rtfToText, tabBlocksToRows } = require('./rtf');
  ctx.progress('Reading the RTF file');
  const text = tabBlocksToRows(rtfToText(Buffer.from(buf)));
  return { markdown: textToMarkdown(text), title: '', headings: [], meta: { format: 'RTF document' }, notes: ['RTF: text, paragraphs and tables are converted; bold, italic and pictures are not.'] };
}

async function odt(buf, ctx) {
  const { convertOdt } = require('./odt');
  ctx.progress('Reading the OpenDocument file');
  const r = await convertOdt(Buffer.from(buf), { maxImageBytes: 20 * 1024 * 1024, maxTotalImageBytes: 300 * 1024 * 1024 });
  if (!r.ok) { const e = new Error(r.notice ? `${r.notice.title}. ${r.notice.detail}` : 'The file could not be read.'); e.code = 'REFUSED'; throw e; }
  const out = htmlToMarkdown(r.html, { image: imageHook(ctx.assets, []) });
  return { markdown: out.markdown, title: out.title, headings: out.headings, meta: { format: 'OpenDocument text' } };
}

function decodeHtml(buf) {
  const b = Buffer.from(buf);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString('utf8');
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  const head = b.subarray(0, 4096).toString('latin1');
  const cs = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
  const label = cs ? cs[1].toLowerCase() : 'utf-8';
  try { return new TextDecoder(label === 'iso-8859-1' || label === 'us-ascii' ? 'windows-1252' : label).decode(b); } catch { return b.toString('utf8'); }
}

async function html(buf, ctx) {
  ctx.progress('Reading the HTML file');
  const out = htmlToMarkdown(decodeHtml(buf), { image: imageHook(ctx.assets, []) });
  return { markdown: out.markdown, title: out.title, headings: out.headings, meta: { format: 'HTML page' } };
}

// ---------------- EPUB ----------------
const { parseXml, findAll, find } = require('./ooxml/xml');

function resolveIn(base, href) {
  const clean = decodeURIComponent(String(href || '').split('#')[0]);
  if (!clean) return '';
  return path.posix.normalize(path.posix.join(path.posix.dirname(base), clean)).replace(/^\/+/, '');
}

async function epub(buf, ctx) {
  const { unzipSync, strFromU8 } = require('fflate');
  const MAX = 64 * 1024 * 1024;
  let textTotal = 0;
  const parts = unzipSync(buf instanceof Uint8Array ? buf : new Uint8Array(buf), {
    filter: (f) => {
      if (/\.(x?html?|opf|xml|ncx)$/i.test(f.name)) { textTotal += f.originalSize; if (textTotal > 256 * 1024 * 1024) { const e = new Error('The text inside this EPUB is larger than 256 MB. It was not converted.'); e.code = 'REFUSED'; throw e; } return f.originalSize < MAX; }
      return ctx.assets.collecting && /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(f.name) && f.originalSize < 20 * 1024 * 1024;
    },
  });
  const text = (n) => (parts[n] ? strFromU8(parts[n]) : '');
  const container = parseXml(text('META-INF/container.xml'));
  const rf = find(container, 'rootfile');
  const opfPath = rf ? rf.attrs['full-path'] : Object.keys(parts).find((n) => n.endsWith('.opf'));
  if (!opfPath || !parts[opfPath]) { const e = new Error('This EPUB has no package file (content.opf). It may be damaged.'); e.code = 'REFUSED'; throw e; }
  const opf = parseXml(text(opfPath));
  const titleEl = findAll(opf, 'dc:title')[0];
  const title = titleEl ? titleEl.children.filter((c) => typeof c === 'string').join('').trim() : '';
  const manifest = new Map(findAll(opf, 'item').map((i) => [i.attrs.id, i.attrs]));
  const spine = findAll(opf, 'itemref').map((r) => manifest.get(r.attrs.idref)).filter((i) => i && /x?html/i.test(i['media-type'] || i.href));
  const chapters = [];
  const headings = [];
  let i = 0;
  for (const item of spine.slice(0, 5000)) {
    const p = resolveIn(opfPath, item.href);
    const h = text(p);
    if (!h) continue;
    ctx.progress(`Chapter ${++i} of ${spine.length}`);
    const out = htmlToMarkdown(h, {
      image: (src, alt) => {
        if (/^data:/i.test(src || '')) return ctx.assets.addDataUri(src, alt);
        const zp = resolveIn(p, src);
        return ctx.assets.add(parts[zp] || null, alt, path.extname(zp).slice(1));
      },
    });
    if (out.markdown.trim()) { chapters.push(out.markdown.trim()); headings.push(...out.headings); }
    ctx.checkCancel();
  }
  return { markdown: M.tidy(chapters.join('\n\n---\n\n')), title, headings, meta: { format: 'EPUB book', chapters: chapters.length } };
}

module.exports = { docx, doc, rtf, odt, html, epub, textToMarkdown, decodeHtml, STYLE_MAP };
