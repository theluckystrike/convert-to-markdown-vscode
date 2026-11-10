'use strict';
// PDF to Markdown with pdf.js (Apache-2.0, legacy build, run inside our worker thread). For each page it reads the
// positioned text, groups it into lines, and then decides what each line is:
//   - a heading, when its font is clearly larger than the body text (sizes ranked into #, ##, ###, ####);
//   - a table row, when two or more lines in a row split into the same number of columns by wide gaps;
//   - a list item, when it starts with a bullet or "1." / "1)";
//   - otherwise part of a paragraph (lines close together are joined, hyphenated words are rejoined).
// Two-column pages are read left column first. Running headers, footers and page numbers that repeat on most pages
// are dropped. Images become placeholders, or PNG files when Extract images is on.
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const M = require('./md');

// pdf.js reads DOMMatrix, Path2D and ImageData at load time. In a browser they exist; in Node pdf.js tries the native
// @napi-rs/canvas package, which we do not ship. Text and image extraction never draw, so small stand-ins are enough.
function polyfill() {
  if (!globalThis.DOMMatrix) {
    class DOMMatrix {
      constructor(init) { const v = Array.isArray(init) && init.length >= 6 ? init : [1, 0, 0, 1, 0, 0]; [this.a, this.b, this.c, this.d, this.e, this.f] = v.map(Number); }
      get m11() { return this.a; } get m12() { return this.b; } get m21() { return this.c; } get m22() { return this.d; } get m41() { return this.e; } get m42() { return this.f; }
      get isIdentity() { return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0; }
      multiplySelf(o) { const m = o instanceof DOMMatrix ? o : new DOMMatrix(o && [o.a, o.b, o.c, o.d, o.e, o.f]); const { a, b, c, d, e, f } = this; this.a = a * m.a + c * m.b; this.b = b * m.a + d * m.b; this.c = a * m.c + c * m.d; this.d = b * m.c + d * m.d; this.e = a * m.e + c * m.f + e; this.f = b * m.e + d * m.f + f; return this; }
      preMultiplySelf(o) { const m = new DOMMatrix([o.a, o.b, o.c, o.d, o.e, o.f]); m.multiplySelf(this); Object.assign(this, { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f }); return this; }
      multiply(o) { return new DOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]).multiplySelf(o); }
      translateSelf(x = 0, y = 0) { return this.multiplySelf(new DOMMatrix([1, 0, 0, 1, x, y])); }
      translate(x, y) { return this.multiply(new DOMMatrix([1, 0, 0, 1, x || 0, y || 0])); }
      scaleSelf(x = 1, y = x) { return this.multiplySelf(new DOMMatrix([x, 0, 0, y, 0, 0])); }
      scale(x = 1, y = x) { return this.multiply(new DOMMatrix([x, 0, 0, y, 0, 0])); }
      invertSelf() { const { a, b, c, d, e, f } = this; const det = a * d - b * c || 1; this.a = d / det; this.b = -b / det; this.c = -c / det; this.d = a / det; this.e = (c * f - d * e) / det; this.f = (b * e - a * f) / det; return this; }
      inverse() { return new DOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]).invertSelf(); }
      transformPoint(p = {}) { const x = p.x || 0, y = p.y || 0; return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: 0, w: 1 }; }
    }
    globalThis.DOMMatrix = DOMMatrix;
  }
  if (!globalThis.Path2D) globalThis.Path2D = class Path2D { addPath() {} moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {} rect() {} closePath() {} };
  if (!globalThis.ImageData) globalThis.ImageData = class ImageData { constructor(a, b, c) { if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); } else { this.data = a; this.width = b; this.height = c; } } };
}

let lib = null;
async function loadPdfjs(dirs) {
  if (lib) return lib;
  polyfill();
  if (!globalThis.pdfjsWorker) globalThis.pdfjsWorker = await import(pathToFileURL(dirs.worker).href);
  lib = await import(pathToFileURL(dirs.lib).href);
  return lib;
}

const BULLET = /^([•◦▪▫‣∙·●○■□➢➤►▶✓✔-]|[*–])\s+/;
const NUMBERED = /^(\d{1,3})([.)])\s+/;
const PAGE_NO = /^\s*(page\s*)?\d{1,5}(\s*(of|\/)\s*\d{1,5})?\s*$/i;

function refused(msg) { const e = new Error(msg); e.code = 'REFUSED'; return e; }

// ---------------- lines ----------------
function toLines(items, fonts, pageWidth = 612) {
  const parts = [];
  for (const it of items) {
    if (typeof it.str !== 'string' || !it.str.trim()) continue; // pdf.js adds a ' ' item for each gap; gaps are measured here
    const t = it.transform || [1, 0, 0, 1, 0, 0];
    const size = Math.round((Math.hypot(t[2], t[3]) || Math.abs(t[0]) || it.height || 10) * 2) / 2;
    const f = fonts(it.fontName);
    parts.push({ s: it.str, x: t[4], y: t[5], w: it.width || it.str.length * size * 0.5, size, bold: !!(f && f.bold) || /bold|black|heavy|semibold/i.test((f && f.name) || '') });
  }
  parts.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const p of parts) {
    const l = lines.length ? lines[lines.length - 1] : null;
    if (l && Math.abs(l.y - p.y) <= Math.max(2, Math.min(l.size, p.size) * 0.45)) l.items.push(p);
    else lines.push({ y: p.y, size: p.size, items: [p] });
    if (lines.length > 20000) break;
  }
  const ordered = splitColumns(lines, pageWidth);
  if (ordered) { lines.length = 0; lines.push(...ordered); }
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    const segs = [];
    let cur = null;
    for (const p of l.items) {
      const gap = cur ? p.x - cur.end : 0;
      if (!cur || gap > Math.max(p.size * 1.6, 14)) {
        cur = { x: p.x, end: p.x + p.w, text: p.s, bold: p.bold, chars: p.s.trim().length, boldChars: p.bold ? p.s.trim().length : 0 };
        segs.push(cur);
      } else {
        const space = gap > p.size * 0.12 && !/\s$/.test(cur.text) && !/^\s/.test(p.s);
        cur.text += (space ? ' ' : '') + p.s;
        cur.end = Math.max(cur.end, p.x + p.w);
        cur.chars += p.s.trim().length;
        if (p.bold) cur.boldChars += p.s.trim().length;
      }
    }
    for (const s of segs) s.text = s.text.replace(/\s+/g, ' ').trim();
    l.segs = segs.filter((s) => s.text);
    l.x = l.segs.length ? l.segs[0].x : 0;
    // the size most of the line's characters have (a run-in bold heading does not make the whole line a heading)
    const by = new Map();
    for (const p of l.items) by.set(p.size, (by.get(p.size) || 0) + p.s.trim().length);
    let best = -1;
    for (const [sz, n] of by) if (n > best || (n === best && sz > l.size)) { best = n; l.size = sz; }
    l.text = l.segs.map((s) => s.text).join(' ');
    const chars = l.segs.reduce((n, s) => n + s.chars, 0);
    l.bold = chars > 0 && l.segs.reduce((n, s) => n + s.boldChars, 0) >= chars * 0.9;
    delete l.items;
  }
  return lines.filter((l) => l.text);
}

/**
 * Two-column page: find a vertical gutter between 30 % and 70 % of the page width that almost no text crosses, with
 * long text on both sides (short cells on both sides are a table, not columns). Returns the lines in reading order
 * (full-width lines above the columns, then the left column, then the right one), or null for a one-column page.
 */
function splitColumns(lines, pageWidth) {
  if (lines.length < 10) return null;
  let best = null;
  for (let x = pageWidth * 0.3; x <= pageWidth * 0.7; x += 2) {
    let cross = 0, left = 0, right = 0, lc = 0, rc = 0;
    for (const l of lines) {
      let c = false, L = 0, R = 0;
      for (const p of l.items) {
        if (p.x < x - 1 && p.x + p.w > x + 1) { c = true; break; }
        if (p.x + p.w <= x + 1) L += p.s.length; else R += p.s.length;
      }
      if (c) cross++;
      else { if (L) { left++; lc += L; } if (R) { right++; rc += R; } }
    }
    if (!best || cross < best.cross) best = { x, cross, left, right, lc, rc };
  }
  const n = lines.length;
  if (!best || best.cross > n * 0.15 || best.left < n * 0.3 || best.right < n * 0.3) return null;
  if (best.lc / best.left < 25 || best.rc / best.right < 25) return null; // short cells: a table
  const x = best.x;
  const top = [], left = [], right = [];
  let firstSplit = null;
  for (const l of lines) {
    const crossing = l.items.some((p) => p.x < x - 1 && p.x + p.w > x + 1);
    if (crossing) { (firstSplit === null ? top : left).push(l); continue; }
    if (firstSplit === null) firstSplit = l.y;
    const L = l.items.filter((p) => p.x + p.w <= x + 1), R = l.items.filter((p) => p.x + p.w > x + 1);
    if (L.length) left.push({ y: l.y, size: l.size, items: L });
    if (R.length) right.push({ y: l.y, size: l.size, items: R });
  }
  return [...top, ...left, ...right];
}

/** Two-column page: most lines have 2 long segments split near the same x. Returns lines in reading order. */
function reorderColumns(lines, pageWidth) {
  const two = lines.filter((l) => l.segs.length === 2 && l.segs[0].text.length > 20 && l.segs[1].text.length > 20);
  if (lines.length < 8 || two.length < lines.length * 0.5) return lines;
  const xs = two.map((l) => l.segs[1].x).sort((a, b) => a - b);
  const split = xs[Math.floor(xs.length / 2)];
  if (split < pageWidth * 0.3 || split > pageWidth * 0.7) return lines;
  const left = [], right = [], full = [];
  for (const l of lines) {
    if (l.segs.length === 2 && Math.abs(l.segs[1].x - split) < 30) {
      left.push({ ...l, segs: [l.segs[0]], text: l.segs[0].text, x: l.segs[0].x });
      right.push({ ...l, segs: [l.segs[1]], text: l.segs[1].text, x: l.segs[1].x });
    } else if (l.x >= split - 5) right.push(l);
    else if (l.segs.length === 1 && l.segs[0].end <= split + 5) left.push(l);
    else full.push(l);
  }
  // full-width lines above the columns (titles) come first
  const top = full.filter((l) => !left.length || l.y > left[0].y);
  const rest = full.filter((l) => !top.includes(l));
  return [...top, ...left, ...right, ...rest];
}

// ---------------- page blocks ----------------
function headingLevel(size, levels) {
  const i = levels.indexOf(size);
  return i < 0 ? 0 : Math.min(4, i + 1);
}

function pageBlocks(lines, ctx, bodySize, levels) {
  const out = [];
  let para = null;
  let lastLi = false;
  const emit = (s, li) => { if (li && lastLi) out[out.length - 1] += '\n' + s; else out.push(s); lastLi = !!li; };
  const flushPara = () => { if (para) { emit(para.kind === 'p' ? M.escapeLine(para.text) : para.md, para.kind === 'li'); para = null; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.image) { flushPara(); emit(l.image); continue; }
    // table: this line and the next ones with the same column count (2+), short cells
    if (l.segs.length >= 2) {
      let j = i;
      while (j + 1 < lines.length && !lines[j + 1].image && lines[j + 1].segs.length === l.segs.length && l.y - lines[j + 1].y < l.size * 3 * (j + 2 - i)) j++;
      const run = lines.slice(i, j + 1);
      const avg = run.reduce((n, r) => n + r.text.length, 0) / run.length / l.segs.length;
      if (run.length >= 2 && avg < 40) {
        flushPara();
        emit(M.table(run.map((r) => r.segs.map((s) => s.text))));
        i = j;
        continue;
      }
    }
    const lvl = l.text.length <= 150 ? headingLevel(l.size, levels) : 0;
    if (lvl) {
      flushPara();
      // a heading split over two lines of the same size
      let text = l.text;
      while (i + 1 < lines.length && !lines[i + 1].image && lines[i + 1].size === l.size && l.y - lines[i + 1].y < l.size * 1.5 && text.length < 150) { text += ' ' + lines[i + 1].text; i++; }
      emit(`${'#'.repeat(lvl)} ${M.escapeText(text)}`);
      ctx.headings.push({ level: lvl, text });
      continue;
    }
    const b = BULLET.exec(l.text);
    const n = !b && NUMBERED.exec(l.text);
    if (b || (n && l.text.length > n[0].length)) {
      flushPara();
      const rest = l.text.slice((b || n)[0].length);
      para = { kind: 'li', x: l.x, y: l.y, size: l.size, md: `${b ? '-' : `${n[1]}.`} ${M.escapeText(rest)}` };
      continue;
    }
    if (l.bold && l.text.length < 90 && l.size <= bodySize + 0.5 && !/[.,;]$/.test(l.text)) {
      flushPara();
      emit(`**${M.escapeText(l.text)}**`);
      continue;
    }
    if (para && para.kind === 'li' && l.x > para.x + 2 && para.y - l.y < l.size * 1.8) { // wrapped list item
      para.md += ' ' + M.escapeText(l.text); para.y = l.y; continue;
    }
    if (para && para.kind === 'p' && Math.abs(para.size - l.size) < 1 && para.y - l.y < l.size * 1.75 && para.y - l.y > 0) {
      if (/[A-Za-z]-$/.test(para.text) && /^[a-z]/.test(l.text)) para.text = para.text.slice(0, -1) + l.text;
      else para.text += ' ' + l.text;
      para.y = l.y;
      continue;
    }
    flushPara();
    para = { kind: 'p', text: l.text, y: l.y, size: l.size };
  }
  flushPara();
  return out;
}

// ---------------- images ----------------
function pngEncode(img) {
  const { width: w, height: h, kind, data } = img;
  if (!w || !h || !data || w * h > 40e6) return null;
  const ch = kind === 3 ? 4 : 3;
  const raw = Buffer.alloc((w * ch + 1) * h);
  if (kind === 1) {
    const stride = (w + 7) >> 3;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = (data[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0; const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = raw[o + 1] = raw[o + 2] = v; }
  } else {
    for (let y = 0; y < h; y++) raw.set(data.subarray(y * w * ch, (y + 1) * w * ch), y * (w * ch + 1) + 1);
  }
  const crcT = pngEncode.t || (pngEncode.t = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }));
  const crc = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ch === 4 ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function getObj(objs, name) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 3000);
    try { objs.get(name, (v) => { clearTimeout(t); resolve(v); }); } catch { clearTimeout(t); resolve(null); }
  });
}

/** Images painted on a page, with the top y of each, from the operator list. */
function imageOps(OPS, ops) {
  const out = [];
  const stack = [];
  let m = [1, 0, 0, 1, 0, 0];
  const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  for (let i = 0; i < ops.fnArray.length && out.length < 500; i++) {
    const fn = ops.fnArray[i];
    if (fn === OPS.save) stack.push(m);
    else if (fn === OPS.restore) m = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) m = mul(m, ops.argsArray[i]);
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const a = ops.argsArray[i];
      const wPt = Math.hypot(m[0], m[1]), hPt = Math.hypot(m[2], m[3]);
      out.push({ name: typeof a[0] === 'string' ? a[0] : null, inline: typeof a[0] === 'string' ? null : a[0], top: m[5] + Math.max(0, m[3]), wPt, hPt });
    }
  }
  return out;
}

// ---------------- main ----------------
async function pdf(buf, ctx) {
  const pdfjs = await loadPdfjs(ctx.pdfjs);
  const data = new Uint8Array(buf.buffer ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf);
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false,
      isOffscreenCanvasSupported: false, isImageDecoderSupported: false, maxImageSize: 25e6,
      cMapUrl: ctx.pdfjs.cmaps ? ctx.pdfjs.cmaps.replace(/\/?$/, '/') : undefined, cMapPacked: true,
    }).promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') throw refused('This PDF is password-protected. Open it in a PDF reader, save a copy without the password and convert that copy.');
    throw refused(`The PDF could not be read: ${String((e && e.message) || e).slice(0, 200)}`);
  }
  try {
    const total = doc.numPages;
    const maxPages = Math.max(1, Math.min(total, (ctx.limits && ctx.limits.maxPages) || 1000));
    let title = '';
    try { const md = await doc.getMetadata(); title = String((md && md.info && md.info.Title) || '').trim(); } catch { /* no metadata */ }
    const pages = [];
    const sizeChars = new Map();
    const seenImages = new Set();
    let chars = 0, imageCount = 0;
    for (let i = 1; i <= maxPages; i++) {
      ctx.progress(`Page ${i} of ${maxPages}`, i / maxPages);
      ctx.checkCancel();
      let page;
      try { page = await doc.getPage(i); } catch (e) { pages.push({ lines: [], error: String(e && e.message || e) }); continue; }
      const view = page.view || [0, 0, 612, 792];
      const height = view[3] - view[1], width = view[2] - view[0];
      let ops = null;
      try { ops = await page.getOperatorList(); } catch { ops = null; }
      const tc = await page.getTextContent();
      const fonts = (name) => { try { return page.commonObjs.has(name) ? page.commonObjs.get(name) : null; } catch { return null; } };
      const lines = toLines(tc.items, fonts, width);
      for (const l of lines) { chars += l.text.length; sizeChars.set(l.size, (sizeChars.get(l.size) || 0) + l.text.length); }
      // images: placeholders or files, placed by their top edge among the lines
      const imgs = [];
      if (ops) {
        for (const im of imageOps(pdfjs.OPS, ops)) {
          if (im.wPt < 24 || im.hPt < 24) continue; // bullets, rules, tiny icons
          const key = im.name ? `${im.name}` : null;
          if (key && seenImages.has(key)) continue; // a logo repeated on every page: once
          if (key) seenImages.add(key);
          imageCount++;
          let md;
          if (ctx.assets.collecting) {
            const obj = im.inline || (im.name ? await getObj(im.name.startsWith('g_') ? page.commonObjs : page.objs, im.name) : null);
            md = ctx.assets.add(obj ? pngEncode(obj) : null, `Image ${imageCount} on page ${i}`, 'png');
          } else md = ctx.assets.add(null, '');
          imgs.push({ y: im.top, image: md, segs: [], text: '', size: 0 });
        }
      }
      pages.push({ lines, imgs, height, n: i });
      page.cleanup();
    }
    // running headers and footers: same text near the same edge on most pages
    const rep = new Map();
    for (const p of pages) for (const l of p.lines || []) {
      if (l.y < p.height * 0.92 && l.y > p.height * 0.08) continue;
      const k = `${l.text.replace(/\d+/g, '#')}@${Math.round(l.y / 4)}`;
      rep.set(k, (rep.get(k) || 0) + 1);
    }
    const minRep = Math.max(3, Math.ceil(pages.length * 0.5));
    let bodySize = 10, best = -1;
    for (const [s, n] of sizeChars) if (n > best) { best = n; bodySize = s; }
    const levels = [...sizeChars.keys()].filter((s) => s >= bodySize * 1.15 && s >= bodySize + 1).sort((a, b) => b - a).slice(0, 4);
    const headings = [];
    const blocks = [];
    for (const p of pages) {
      let lines = (p.lines || []).filter((l) => {
        const edge = l.y >= p.height * 0.92 || l.y <= p.height * 0.08;
        if (!edge) return true;
        if (PAGE_NO.test(l.text)) return false;
        return (rep.get(`${l.text.replace(/\d+/g, '#')}@${Math.round(l.y / 4)}`) || 0) < minRep || pages.length < 3;
      });
      if (p.imgs && p.imgs.length) {
        for (const im of p.imgs) {
          const at = lines.findIndex((l) => l.y < im.y - 1);
          if (at < 0) lines.push(im); else lines.splice(at, 0, im);
        }
      }
      const b = pageBlocks(lines, { headings }, bodySize, levels);
      if (b.length) blocks.push(b.join('\n\n'));
    }
    const notes = [];
    if (total > maxPages) notes.push(`Only the first ${maxPages.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} pages were converted (setting toMarkdown.pdfMaxPages).`);
    if (chars < 20 * pages.length) notes.push(imageCount ? 'This PDF has little or no text: it looks like scanned pages. Text recognition (OCR) is not part of this extension, so only the images are listed.' : 'This PDF has little or no text to convert.');
    let markdown = blocks.join('\n\n');
    if (total > maxPages) markdown += `\n\n*${notes[0]}*`;
    if (!title && headings.length) title = headings[0].text;
    return { markdown: M.tidy(markdown), title, headings, meta: { format: 'PDF', pages: total }, notes };
  } finally {
    try { await doc.destroy(); } catch { /* already gone */ }
  }
}

module.exports = { pdf, toLines, reorderColumns, pageBlocks, pngEncode, PAGE_NO };
