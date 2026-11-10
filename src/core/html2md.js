'use strict';
// HTML to Markdown (GitHub flavour): headings, paragraphs, emphasis, links, lists (nested), code blocks, tables,
// block quotes and images. parse5 (MIT) builds the tree the way a browser would, so broken HTML still converts.
// Scripts, styles and forms are dropped; text that looks like HTML stays text. Deep nesting is flattened to text
// (no recursion past MAX_DEPTH), so a hostile file cannot overflow the stack.
const { parse } = require('parse5');
const M = require('./md');

const MAX_DEPTH = 120;
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'svg', 'math', 'iframe', 'object', 'embed', 'canvas', 'button', 'input', 'select', 'textarea', 'option', 'video', 'audio', 'source', 'track', 'map', 'meta', 'link', 'base', 'title', 'nav-skip']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav', 'figure', 'figcaption', 'body', 'html', 'center', 'form', 'fieldset', 'details', 'summary', 'address', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'pre', 'blockquote', 'table', 'hr', 'caption', 'legend', 'hgroup', 'menu', 'dir']);

const attr = (n, name) => { const a = (n.attrs || []).find((x) => x.name === name); return a ? a.value : ''; };
const tag = (n) => (n.tagName || '').toLowerCase();
const isText = (n) => n.nodeName === '#text';

/** Text of a subtree without recursion. */
function textContent(node) {
  let s = '';
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (isText(n)) { s += n.value; continue; }
    if (SKIP.has(tag(n))) continue;
    const kids = n.content ? n.content.childNodes : n.childNodes;
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return s;
}

function fenceFor(text, ch = '`', min = 3) {
  let longest = 0;
  const re = new RegExp(`${ch === '`' ? '`' : '~'}+`, 'g');
  let m;
  while ((m = re.exec(text))) longest = Math.max(longest, m[0].length);
  return ch.repeat(Math.max(min, longest + 1));
}

function inlineCode(text) {
  const t = text.replace(/\s+/g, ' ');
  if (!t.trim()) return '';
  let longest = 0;
  for (const m of t.match(/`+/g) || []) longest = Math.max(longest, m.length);
  const f = '`'.repeat(longest + 1);
  const pad = /^`|`$/.test(t) || /^ .* $/.test(t) ? ' ' : '';
  return f + pad + t + pad + f;
}

function wrap(s, mark) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  if (!m[2]) return s;
  return `${m[1]}${mark}${m[2]}${mark}${m[3]}`;
}

function safeHref(href) {
  const h = String(href || '').trim();
  if (!h || /^(javascript|vbscript|data):/i.test(h)) return '';
  return /[\s()<>]/.test(h) ? `<${h.replace(/[<>]/g, encodeURIComponent)}>` : h;
}

class Writer {
  constructor(opts) {
    this.opts = opts;
    this.image = opts.image || null; // (src, alt) => markdown or null for the default placeholder
    this.title = '';
    this.headings = [];
    this.images = 0;
    this.chars = 0;
    this.maxChars = opts.maxChars || 64 * 1024 * 1024;
  }

  // ---- inline ----
  inline(node, depth) {
    if (isText(node)) return M.escapeText(node.value.replace(/\s+/g, ' '));
    const t = tag(node);
    if (!t || SKIP.has(t)) return '';
    if (depth > MAX_DEPTH) return M.escapeText(textContent(node).replace(/\s+/g, ' '));
    const kids = () => this.inlineKids(node, depth + 1);
    switch (t) {
      case 'br': return '\\\n';
      case 'strong': case 'b': return wrap(kids(), '**');
      case 'em': case 'i': case 'cite': case 'dfn': return wrap(kids(), '*');
      case 'del': case 's': case 'strike': return wrap(kids(), '~~');
      case 'code': case 'kbd': case 'samp': case 'tt': return inlineCode(textContent(node));
      case 'a': {
        const text = kids().trim();
        const href = safeHref(attr(node, 'href'));
        if (!text) return '';
        if (!href || href.startsWith('#')) return text;
        return `[${text}](${href})`;
      }
      case 'img': return this.img(node);
      case 'wbr': return '';
      default: return kids();
    }
  }

  inlineKids(node, depth) {
    let s = '';
    for (const c of node.childNodes || []) s += this.inline(c, depth);
    return s;
  }

  img(node) {
    const alt = (attr(node, 'alt') || attr(node, 'title') || '').replace(/\s+/g, ' ').trim();
    const src = attr(node, 'src');
    this.images++;
    if (this.image) {
      const r = this.image(src, alt, this.images);
      if (r != null) return r;
    }
    return `*[Image${alt ? `: ${M.escapeText(alt)}` : ''}]*`;
  }

  // ---- blocks ----
  /** Returns a list of block strings for the children of node. Inline runs become paragraphs. */
  blocks(node, depth) {
    const out = [];
    let run = '';
    const flush = () => {
      const p = run.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/ {2,}/g, ' ').replace(/^(\s|\\\n)+|(\s|\\\n)+$/g, '').trim();
      if (p && p !== '\\') out.push(p.replace(/^([#>+=|-])/, '\\$1').replace(/^(\d+)([.)])(\s)/, '$1\\$2$3'));
      run = '';
    };
    const kids = node.content ? node.content.childNodes : node.childNodes || [];
    for (const c of kids) {
      const t = tag(c);
      if (!isText(c) && t && BLOCK.has(t) && depth <= MAX_DEPTH) {
        flush();
        const b = this.block(c, depth + 1);
        if (b) out.push(...(Array.isArray(b) ? b : [b]));
      } else if (!isText(c) && depth > MAX_DEPTH && t && !SKIP.has(t)) {
        run += M.escapeText(textContent(c).replace(/\s+/g, ' '));
      } else {
        run += this.inline(c, depth + 1);
      }
      if (this.chars > this.maxChars) break;
    }
    flush();
    for (const b of out) this.chars += b.length;
    return out;
  }

  block(node, depth) {
    const t = tag(node);
    switch (t) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const level = Number(t[1]);
        const text = this.inlineKids(node, depth).replace(/\\\n/g, ' ').replace(/\s+/g, ' ').trim();
        if (!text) return null;
        this.headings.push({ level, text });
        if (!this.title && level === 1) this.title = textContent(node).replace(/\s+/g, ' ').trim();
        return `${'#'.repeat(level)} ${text}`;
      }
      case 'hr': return '---';
      case 'pre': {
        const code = node.childNodes && node.childNodes.find((c) => tag(c) === 'code');
        const cls = attr(code || node, 'class');
        const lang = (/(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(cls) || [])[1] || '';
        const text = textContent(node).replace(/^\n/, '').replace(/\n$/, '');
        const f = fenceFor(text);
        return `${f}${lang}\n${text}\n${f}`;
      }
      case 'ul': case 'ol': case 'menu': case 'dir': return this.list(node, depth, t === 'ol');
      case 'blockquote': {
        const inner = this.blocks(node, depth).join('\n\n');
        return inner ? inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n') : null;
      }
      case 'table': return this.table(node, depth);
      case 'dl': {
        const out = [];
        for (const c of node.childNodes || []) {
          const ct = tag(c);
          if (ct === 'dt') { const s = this.inlineKids(c, depth).trim(); if (s) out.push(`**${s}**`); }
          else if (ct === 'dd') { const s = this.blocks(c, depth).join('\n\n'); if (s) out.push(`: ${s}`); }
          else if (ct === 'div') out.push(...[this.block(c, depth)].flat().filter(Boolean));
        }
        return out;
      }
      default: return this.blocks(node, depth);
    }
  }

  list(node, depth, ordered) {
    const lines = [];
    let n = Number(attr(node, 'start')) || 1;
    for (const li of node.childNodes || []) {
      const t = tag(li);
      if (t === 'ul' || t === 'ol') { // a list directly inside a list: indent it under the previous item
        const sub = this.list(li, depth + 1, t === 'ol');
        if (sub) lines.push(sub.split('\n').map((l) => (l ? `    ${l}` : l)).join('\n'));
        continue;
      }
      if (t !== 'li') continue;
      const marker = ordered ? `${n++}.` : '-';
      const pad = ' '.repeat(marker.length + 1);
      const body = this.blocks(li, depth + 1);
      if (!body.length) { lines.push(marker); continue; }
      const text = body.reduce((acc, b) => (acc ? acc + (/^(\d+\.|-) /.test(b) ? '\n' : '\n\n') + b : b), '').split('\n').map((l, i) => (i === 0 ? `${marker} ${l}` : l ? pad + l : l)).join('\n');
      lines.push(text);
    }
    if (!lines.length) return null;
    // Tight list when no item has a blank line inside.
    return lines.join('\n');
  }

  table(node, depth) {
    if (this.inCell) { // a table inside a table cell: its text, cells separated by " / "
      const cells = [];
      const stack = [node];
      while (stack.length && cells.length < 2000) {
        const n = stack.shift();
        for (const c of n.childNodes || []) { const t = tag(c); if (t === 'td' || t === 'th') cells.push(textContent(c).replace(/\s+/g, ' ').trim()); else if (!isText(c)) stack.push(c); }
      }
      return M.escapeText(cells.filter(Boolean).join(' / '));
    }
    const rows = [];
    let headerRow = false;
    const stack = [node];
    const trs = [];
    while (stack.length) { // rows in document order, without entering nested tables
      const n = stack.shift();
      for (const c of n.childNodes || []) {
        const t = tag(c);
        if (t === 'tr') trs.push(c);
        else if (t === 'thead' || t === 'tbody' || t === 'tfoot') stack.push(c);
      }
    }
    for (const tr of trs.slice(0, 20000)) {
      const row = [];
      for (const td of tr.childNodes || []) {
        const t = tag(td);
        if (t !== 'td' && t !== 'th') continue;
        if (rows.length === 0 && t === 'th') headerRow = true;
        this.inCell = (this.inCell || 0) + 1;
        const parts = this.blocks(td, depth + 1).join(' ').replace(/\n+/g, ' ');
        this.inCell--;
        row.push({ md: parts });
        const span = Math.min(Number(attr(td, 'colspan')) || 1, 50);
        for (let i = 1; i < span; i++) row.push({ md: '' });
      }
      if (row.length) rows.push(row);
    }
    if (!rows.length) return null;
    const cols = Math.min(200, rows.reduce((m, r) => Math.max(m, r.length), 1));
    const fmt = (r) => { const o = r.slice(0, cols).map((c) => c.md.replace(/\|/g, '\\|').trim()); while (o.length < cols) o.push(''); return `| ${o.join(' | ')} |`; };
    const head = headerRow ? rows[0] : rows[0];
    const lines = [fmt(head), `|${' --- |'.repeat(cols)}`, ...rows.slice(1).map(fmt)];
    const caption = (node.childNodes || []).find((c) => tag(c) === 'caption');
    const cap = caption ? this.inlineKids(caption, depth).trim() : '';
    return cap ? [`*${cap}*`, lines.join('\n')] : lines.join('\n');
  }
}

/**
 * html: string. opts.image(src, alt, n) may return the Markdown for an image (or null for the placeholder).
 * Returns { markdown, title, headings, images }.
 */
function htmlToMarkdown(html, opts = {}) {
  const doc = parse(String(html));
  const w = new Writer(opts);
  let title = '';
  const htmlEl = (doc.childNodes || []).find((c) => tag(c) === 'html');
  const head = htmlEl && htmlEl.childNodes.find((c) => tag(c) === 'head');
  const t = head && head.childNodes.find((c) => tag(c) === 'title');
  if (t) title = textContent(t).replace(/\s+/g, ' ').trim();
  const body = htmlEl ? htmlEl.childNodes.find((c) => tag(c) === 'body') || htmlEl : doc;
  const blocks = w.blocks(body, 0);
  const markdown = M.tidy(blocks.join('\n\n'));
  return { markdown, title: title || w.title, headings: w.headings, images: w.images };
}

module.exports = { htmlToMarkdown, textContent };
