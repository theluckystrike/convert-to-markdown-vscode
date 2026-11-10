'use strict';
// PowerPoint (.pptx, .pptm, .ppsx, .potx) to Markdown: one "## Slide n: title" section per slide with its text as
// bullets (levels kept), tables as pipe tables, pictures, and the speaker notes. Based on the PPTX Viewer reader.
// Reads only the XML parts (media only when images are extracted), so a deck full of video converts fast.
const { unzipSync } = require('fflate');
const { readXmlParts, resolveTarget, relsPathFor } = require('./ooxml/zip');
const { parseXml, child, find, findAll, elements, local } = require('./ooxml/xml');
const M = require('./md');

const REL_NOTES = /\/notesSlide$/;
const SKIP_PH = new Set(['sldNum', 'dt', 'ftr', 'hdr', 'sldImg']);
const TITLE_PH = new Set(['title', 'ctrTitle']);
const MAX_SLIDES = 5000;

function parseRels(xml) {
  const map = new Map();
  if (!xml) return map;
  for (const r of findAll(parseXml(xml), 'Relationship')) map.set(r.attrs.Id, { type: r.attrs.Type || '', target: r.attrs.Target || '', external: r.attrs.TargetMode === 'External' });
  return map;
}

function placeholderType(sp) {
  const nv = elements(sp).find((e) => local(e.name).startsWith('nv'));
  const ph = nv && find(nv, 'p:ph');
  return ph ? ph.attrs.type || 'body' : null;
}

/** Text of one a:p with bold/italic runs and hyperlinks as Markdown. */
function paragraphMd(p, rels) {
  let s = '';
  for (const c of elements(p)) {
    const n = local(c.name);
    if (n === 'r' || n === 'fld') {
      const t = child(c, 'a:t');
      let text = t ? t.children.filter((x) => typeof x === 'string').join('') : '';
      if (!text) continue;
      let md = M.escapeText(text.replace(/\u000b/g, ' '));
      const rPr = child(c, 'a:rPr');
      if (rPr && md.trim()) {
        const b = rPr.attrs.b === '1' || rPr.attrs.b === 'true';
        const i = rPr.attrs.i === '1' || rPr.attrs.i === 'true';
        const lead = /^\s*/.exec(md)[0], trail = /\s*$/.exec(md)[0];
        let core = md.trim();
        if (b) core = `**${core}**`;
        if (i) core = `*${core}*`;
        const link = child(rPr, 'a:hlinkClick');
        const rel = link && rels.get(link.attrs['r:id']);
        if (rel && rel.external && /^(https?|mailto):/i.test(rel.target)) core = `[${core}](${/[\s()]/.test(rel.target) ? `<${rel.target}>` : rel.target})`;
        md = lead + core + trail;
      }
      s += md;
    } else if (n === 'br') s += ' ';
  }
  return s.replace(/\*\*\*\*/g, '').trim();
}

function textParagraphs(txBody, rels) {
  const out = [];
  for (const p of elements(txBody)) {
    if (p.name !== 'a:p') continue;
    const md = paragraphMd(p, rels);
    if (!md) continue;
    const pPr = child(p, 'a:pPr');
    const level = pPr && pPr.attrs.lvl ? Math.min(8, parseInt(pPr.attrs.lvl, 10) || 0) : 0;
    const numbered = !!(pPr && child(pPr, 'a:buAutoNum'));
    const noBullet = !!(pPr && child(pPr, 'a:buNone'));
    out.push({ md, level, numbered, noBullet });
  }
  return out;
}

function tableRows(tbl, rels) {
  return elements(tbl).filter((e) => e.name === 'a:tr').slice(0, 5000).map((tr) =>
    elements(tr).filter((e) => e.name === 'a:tc').map((tc) => {
      const body = child(tc, 'a:txBody');
      return body ? textParagraphs(body, rels).map((p) => p.md).join(' ') : '';
    }));
}

function walk(tree, slide, rels, depth = 0) {
  if (depth > 50) return;
  for (const el of elements(tree)) {
    const n = el.name;
    if (n === 'p:sp') {
      const ph = placeholderType(el);
      if (ph && SKIP_PH.has(ph)) continue;
      const body = child(el, 'p:txBody');
      if (!body) continue;
      const paras = textParagraphs(body, rels);
      if (!paras.length) continue;
      if (ph && TITLE_PH.has(ph) && !slide.title) slide.title = paras.map((p) => p.md).join(' ');
      else slide.blocks.push({ kind: ph === 'subTitle' ? 'subtitle' : 'text', paras });
    } else if (n === 'p:grpSp') walk(el, slide, rels, depth + 1);
    else if (n === 'p:graphicFrame') {
      const gd = find(el, 'a:graphicData');
      const uri = gd ? gd.attrs.uri || '' : '';
      const tbl = gd && find(gd, 'a:tbl');
      if (tbl) slide.blocks.push({ kind: 'table', rows: tableRows(tbl, rels) });
      else if (/\/chart$/.test(uri) || /chartex/i.test(uri)) slide.blocks.push({ kind: 'note', text: 'Chart' });
      else if (/\/diagram$/.test(uri)) slide.blocks.push({ kind: 'note', text: 'SmartArt diagram' });
    } else if (n === 'p:pic') {
      const nvPr = find(el, 'p:nvPr');
      if (nvPr && (find(nvPr, 'a:videoFile') || find(nvPr, 'p14:media'))) { slide.blocks.push({ kind: 'note', text: 'Video' }); continue; }
      if (nvPr && find(nvPr, 'a:audioFile')) { slide.blocks.push({ kind: 'note', text: 'Audio' }); continue; }
      const c = find(el, 'p:cNvPr');
      const blip = find(el, 'a:blip');
      slide.blocks.push({ kind: 'image', rid: blip ? blip.attrs['r:embed'] : '', alt: c ? (c.attrs.descr || c.attrs.title || '').trim() : '' });
    } else if (n === 'mc:AlternateContent') {
      const choice = child(el, 'mc:Choice') || child(el, 'mc:Fallback');
      if (choice) walk(choice, slide, rels, depth + 1);
    }
  }
}

function notesText(xml, rels) {
  const tree = find(parseXml(xml), 'p:spTree');
  if (!tree) return [];
  const out = [];
  for (const sp of findAll(tree, 'p:sp')) {
    if (placeholderType(sp) !== 'body') continue;
    const body = child(sp, 'p:txBody');
    if (body) for (const p of textParagraphs(body, rels)) out.push(p.md);
  }
  return out;
}

const MAIN_TYPES = /presentationml\.(presentation|slideshow|template)\.main\+xml|ms-powerpoint\.(presentation|slideshow|template)\.macroEnabled\.main\+xml/;

async function pptx(buf, ctx) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const parts = readXmlParts(bytes);
  let mainPart = 'ppt/presentation.xml';
  const ct = parts.get('[Content_Types].xml');
  if (ct) for (const o of findAll(parseXml(ct), 'Override')) if (MAIN_TYPES.test(o.attrs.ContentType || '')) { mainPart = (o.attrs.PartName || '').replace(/^\//, ''); break; }
  const presXml = parts.get(mainPart);
  if (!presXml) { const e = new Error('No presentation part found. This is not a PowerPoint file or it is damaged.'); e.code = 'REFUSED'; throw e; }
  const pres = parseXml(presXml);
  const rels = parseRels(parts.get(relsPathFor(mainPart)));
  const ids = find(pres, 'p:sldIdLst');
  const list = ids ? elements(ids).filter((e) => e.name === 'p:sldId') : [];
  const slides = [];
  const wanted = new Map(); // media part -> [image block]
  for (const sid of list.slice(0, MAX_SLIDES)) {
    const rel = rels.get(sid.attrs['r:id']);
    if (!rel || rel.external) continue;
    const part = resolveTarget(mainPart, rel.target);
    const xml = parts.get(part);
    const slide = { index: slides.length + 1, title: '', blocks: [], notes: [], hidden: false };
    slides.push(slide);
    if (!xml) continue;
    const docx = parseXml(xml);
    const sld = find(docx, 'p:sld');
    if (sld && sld.attrs.show === '0') slide.hidden = true;
    const srels = parseRels(parts.get(relsPathFor(part)));
    const tree = find(docx, 'p:spTree');
    if (tree) walk(tree, slide, srels);
    for (const b of slide.blocks) if (b.kind === 'image') {
      const r = srels.get(b.rid);
      if (r && !r.external) { b.part = resolveTarget(part, r.target); if (!wanted.has(b.part)) wanted.set(b.part, []); wanted.get(b.part).push(b); }
    }
    for (const r of srels.values()) if (REL_NOTES.test(r.type) && !r.external) {
      const nx = parts.get(resolveTarget(part, r.target));
      if (nx) slide.notes = notesText(nx, srels);
    }
    if (slides.length % 20 === 0) { ctx.progress(`Slide ${slides.length} of ${list.length}`); ctx.checkCancel(); }
  }
  let media = {};
  if (ctx.assets.collecting && wanted.size) {
    media = unzipSync(bytes, { filter: (f) => wanted.has(f.name) && f.originalSize < 50 * 1024 * 1024 });
  }
  const out = [];
  const headings = [];
  for (const s of slides) {
    const title = s.title || '';
    const h = `Slide ${s.index}${title ? `: ${title}` : ''}${s.hidden ? ' (hidden)' : ''}`;
    headings.push({ level: 2, text: h });
    const lines = [`## ${h}`];
    for (const b of s.blocks) {
      lines.push('');
      if (b.kind === 'subtitle') lines.push(b.paras.map((p) => `*${p.md}*`).join('\n\n'));
      else if (b.kind === 'text') {
        const bullets = b.paras.length > 1 || b.paras.some((p) => p.level > 0);
        let n = 0;
        lines.push(b.paras.map((p) => {
          if (!bullets || p.noBullet) return p.md;
          const marker = p.numbered ? `${++n}.` : '-';
          return `${'  '.repeat(p.level)}${marker} ${p.md}`;
        }).join(bullets ? '\n' : '\n\n'));
      } else if (b.kind === 'table' && b.rows.length) lines.push(M.table(b.rows, { raw: true }));
      else if (b.kind === 'image') lines.push(ctx.assets.add(b.part ? media[b.part] : null, b.alt, b.part ? b.part.split('.').pop() : ''));
      else if (b.kind === 'note') lines.push(`*[${b.text}]*`);
    }
    if (s.notes.length) lines.push('', `> **Notes:** ${s.notes.join('\n>\n> ')}`);
    out.push(lines.join('\n'));
  }
  const first = slides.find((s) => s.title);
  return { markdown: M.tidy(out.join('\n\n')), title: first ? first.title.replace(/[*\\]/g, '') : '', headings, meta: { format: 'PowerPoint presentation', slides: slides.length }, notes: list.length > MAX_SLIDES ? [`Only the first ${MAX_SLIDES} of ${list.length} slides were converted.`] : [] };
}

module.exports = { pptx };
