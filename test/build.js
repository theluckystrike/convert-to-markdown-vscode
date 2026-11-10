'use strict';
// Builds the test fixtures in code: PDF, DOCX, PPTX, XLSX, ODT, EPUB, RTF and ZIP files, byte by byte.
// No fixture file is stored in the repo and none is larger than a few MB.
const zlib = require('zlib');

// ---------------- ZIP ----------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** entries: { name: string|Buffer } or [[name, data, { store, fakeSize }]]. Returns a Buffer. */
function zip(entries) {
  const list = Array.isArray(entries) ? entries : Object.entries(entries);
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, data0, opt = {}] of list) {
    const data = Buffer.isBuffer(data0) ? data0 : Buffer.from(String(data0), 'utf8');
    const store = opt.store || name === 'mimetype';
    const comp = store ? data : zlib.deflateRawSync(data, { level: 9 });
    const nb = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const size = opt.fakeSize != null ? opt.fakeSize : data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(store ? 0 : 8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(nb.length, 26);
    locals.push(lh, nb, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(store ? 0 : 8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(size, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    centrals.push(ch, nb);
    off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(list.length, 8); end.writeUInt16LE(list.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------------- PNG ----------------
function png(w, h, rgb = [200, 40, 40]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = rgb[0]; raw[o + 1] = (rgb[1] + x * 3) & 255; raw[o + 2] = rgb[2]; }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------- PDF ----------------
const pdfStr = (s) => '(' + String(s).replace(/[\\()]/g, (c) => '\\' + c) + ')';
/**
 * pages: [{ items: [{ text, x, y, size, bold }], image?: { x, y, w, h, px, py } }], opts.pageCount repeats a blank page.
 * Fonts: F1 Helvetica, F2 Helvetica-Bold. Page 612 x 792.
 */
function pdf(pages, opts = {}) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null), pagesId = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  const all = opts.pageCount ? Array.from({ length: opts.pageCount }, (_, i) => pages[i % pages.length]) : pages;
  const contentIds = new Map();
  for (const p of all) {
    let cid = contentIds.get(p);
    let imgRef = '';
    if (!cid) {
      let s = '';
      for (const it of p.items || []) s += `BT /${it.bold ? 'F2' : 'F1'} ${it.size || 12} Tf ${it.x || 72} ${it.y} Td ${pdfStr(it.text)} Tj ET\n`;
      if (p.image) {
        const { px = 8, py = 8 } = p.image;
        const pix = Buffer.alloc(px * py * 3);
        for (let i = 0; i < px * py; i++) { pix[i * 3] = 30; pix[i * 3 + 1] = (i * 7) & 255; pix[i * 3 + 2] = 200; }
        const z = zlib.deflateSync(pix);
        const im = add({ head: `<< /Type /XObject /Subtype /Image /Width ${px} /Height ${py} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${z.length} >>`, data: z });
        p._img = im;
        s += `q ${p.image.w} 0 0 ${p.image.h} ${p.image.x} ${p.image.y} cm /Im1 Do Q\n`;
      }
      cid = add({ head: `<< /Length ${Buffer.byteLength(s, 'latin1')} >>`, data: Buffer.from(s, 'latin1') });
      contentIds.set(p, cid);
    }
    if (p._img) imgRef = ` /XObject << /Im1 ${p._img} 0 R >>`;
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${cid} 0 R /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>${imgRef} >> >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
  const info = opts.title ? add(`<< /Title ${pdfStr(opts.title)} >>`) : 0;
  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let off = chunks[0].length;
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(off);
    let b;
    if (o && typeof o === 'object') b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${o.head}\nstream\n`, 'latin1'), o.data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    else b = Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
    chunks.push(b); off += b.length;
  });
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += String(o).padStart(10, '0') + ' 00000 n \n';
  xref += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R${info ? ` /Info ${info} 0 R` : ''} >>\nstartxref\n${off}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

/** A report-like PDF: a big bold title, a section heading, paragraphs, a 3-column table, a second page. */
function samplePdf() {
  return pdf([
    { items: [
      { text: 'Quarterly Water Report', x: 72, y: 720, size: 24, bold: true },
      { text: 'Summary', x: 72, y: 680, size: 16, bold: true },
      { text: 'The plant treated more water this quarter than last year.', x: 72, y: 655, size: 11 },
      { text: 'Demand rose in the summer months and fell in the autumn.', x: 72, y: 641, size: 11 },
      { text: 'Results by site', x: 72, y: 600, size: 16, bold: true },
      { text: 'Site', x: 72, y: 575, size: 11, bold: true }, { text: 'Volume', x: 250, y: 575, size: 11, bold: true }, { text: 'Change', x: 400, y: 575, size: 11, bold: true },
      { text: 'North', x: 72, y: 560, size: 11 }, { text: '1200', x: 250, y: 560, size: 11 }, { text: '+4%', x: 400, y: 560, size: 11 },
      { text: 'South', x: 72, y: 545, size: 11 }, { text: '980', x: 250, y: 545, size: 11 }, { text: '-2%', x: 400, y: 545, size: 11 },
      { text: 'East', x: 72, y: 530, size: 11 }, { text: '1515', x: 250, y: 530, size: 11 }, { text: '+9%', x: 400, y: 530, size: 11 },
      { text: '- First point of the list', x: 72, y: 490, size: 11 },
      { text: '- Second point with <b>tags</b> kept as text', x: 72, y: 476, size: 11 },
    ], image: { x: 72, y: 300, w: 120, h: 120, px: 16, py: 16 } },
    { items: [
      { text: 'Outlook', x: 72, y: 720, size: 16, bold: true },
      { text: 'Next quarter the new pipe in the East site comes online.', x: 72, y: 695, size: 11 },
    ] },
  ], { title: 'Quarterly Water Report' });
}

// ---------------- DOCX ----------------
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const wp = (text, style, runs) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${runs || `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`}</w:p>`;
const wr = (text, { b, i, code } = {}) => `<w:r><w:rPr>${b ? '<w:b/>' : ''}${i ? '<w:i/>' : ''}${code ? '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>' : ''}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const wli = (text, numId, lvl) => `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr><w:r><w:t>${esc(text)}</w:t></w:r></w:p>`;
const wimg = (rid, name, descr) => `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><wp:docPr id="1" name="${esc(name)}" descr="${esc(descr)}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="${esc(name)}" descr="${esc(descr)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

function docx({ body, images = [], numbering = true, extraParts = {} } = {}) {
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}>${['Title', 'Heading1', 'Heading2', 'Heading3', 'ListParagraph', 'Quote'].map((s) => `<w:style w:type="paragraph" w:styleId="${s}"><w:name w:val="${s.replace(/(\d)/, ' $1').replace('ListParagraph', 'List Paragraph').replace('Heading', 'heading').replace(/^Title$/, 'Title')}"/></w:style>`).join('')}</w:styles>`;
  const num = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${numbering ? '<Relationship Id="rIdN" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' : ''}<Relationship Id="rIdL" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/report?a=1&amp;b=2" TargetMode="External"/>${images.map((im, i) => `<Relationship Id="rIdI${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.png"/>`).join('')}</Relationships>`;
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const files = {
    '[Content_Types].xml': ct,
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
    'docProps/core.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Project Plan</dc:title></cp:coreProperties>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
    'word/styles.xml': styles,
    'word/_rels/document.xml.rels': rels,
    ...extraParts,
  };
  if (numbering) files['word/numbering.xml'] = num;
  images.forEach((im, i) => { files[`word/media/image${i + 1}.png`] = im; });
  return zip(files);
}

function sampleDocx() {
  const body = [
    wp('Project Plan', 'Title'),
    wp('Goals', 'Heading1'),
    wp('', null, wr('This plan has ') + wr('bold', { b: true }) + wr(' and ') + wr('italic', { i: true }) + wr(' words, and a ') + '<w:hyperlink r:id="rIdL"><w:r><w:t>link</w:t></w:r></w:hyperlink>' + wr('.')),
    wli('First goal', 1, 0), wli('Nested detail', 1, 1), wli('Second goal', 1, 0),
    wli('Step one', 2, 0), wli('Step two', 2, 0),
    wp('Budget', 'Heading2'),
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cost</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Pipes | fittings</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1,200</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Labour</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>800</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    wp('<script>alert(1)</script> stays text', null),
    wimg('rIdI1', 'Site map', 'Map of the site'),
    wp('A quote from the client.', 'Quote'),
  ].join('');
  return docx({ body, images: [png(12, 12)] });
}

// ---------------- PPTX ----------------
const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const sp = (ph, paras) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paras.map((p) => typeof p === 'string' ? `<a:p><a:r><a:t>${esc(p)}</a:t></a:r></a:p>` : `<a:p><a:pPr lvl="${p.lvl}"/><a:r><a:t>${esc(p.t)}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;
const pic = (rid, descr) => `<p:pic><p:nvPicPr><p:cNvPr id="5" name="Picture" descr="${esc(descr)}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/></p:blipFill><p:spPr/></p:pic>`;
const tbl = (rows) => `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="T"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>${rows.map((r) => `<a:tr>${r.map((c) => `<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>${esc(c)}</a:t></a:r></a:p></a:txBody></a:tc>`).join('')}</a:tr>`).join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;

/** slides: [{ shapes: xml string, notes?: string, image?: Buffer }] */
function pptx(slides) {
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`,
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    'ppt/presentation.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${P}><p:sldIdLst>${slides.map((s, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`,
  };
  slides.forEach((s, i) => {
    const n = i + 1;
    files[`ppt/slides/slide${n}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${s.shapes}</p:spTree></p:cSld></p:sld>`;
    let rels = '';
    if (s.notes) {
      rels += `<Relationship Id="rIdN" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/>`;
      files[`ppt/notesSlides/notesSlide${n}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes ${P}><p:cSld><p:spTree>${sp('body', [s.notes])}</p:spTree></p:cSld></p:notes>`;
    }
    if (s.image) {
      rels += `<Relationship Id="rIdP" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${n}.png"/>`;
      files[`ppt/media/image${n}.png`] = s.image;
    }
    files[`ppt/slides/_rels/slide${n}.xml.rels`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
  });
  return zip(files);
}

function samplePptx() {
  return pptx([
    { shapes: sp('ctrTitle', ['Launch Review']) + sp('subTitle', ['Team update, March']), notes: 'Welcome everyone.' },
    { shapes: sp('title', ['What went well']) + sp('body', ['Shipped on time', { t: 'All tests green', lvl: 1 }, 'Few support tickets']) + pic('rIdP', 'Chart of tickets'), image: png(10, 10, [20, 120, 220]), notes: 'Mention the support team.' },
    { shapes: sp('title', ['Numbers']) + tbl([['Metric', 'Value'], ['Users', '1,024'], ['Errors | warnings', '3']]) },
  ]);
}

// ---------------- XLSX (minimal SpreadsheetML) ----------------
function xlsx(sheets) {
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
  };
  const col = (n) => { let s = ''; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  sheets.forEach((s, i) => {
    const rows = s.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => v == null ? '' : typeof v === 'number' ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join('')}</row>`).join('');
    files[`xl/worksheets/sheet${i + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });
  return zip(files);
}
const sampleXlsx = () => xlsx([
  { name: 'Sales', rows: [['Region', 'Q1', 'Q2'], ['North', 120, 135], ['South | West', 98, 101]] },
  { name: 'Notes', rows: [['Note'], ['Checked by finance']] },
]);

// ---------------- ODT ----------------
function odt(bodyXml) {
  const NSX = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"';
  return zip([
    ['mimetype', 'application/vnd.oasis.opendocument.text', { store: true }],
    ['META-INF/manifest.xml', '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/></manifest:manifest>'],
    ['content.xml', `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NSX}><office:automatic-styles><style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style></office:automatic-styles><office:body><office:text>${bodyXml}</office:text></office:body></office:document-content>`],
    ['styles.xml', `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NSX}><office:styles/></office:document-styles>`],
  ]);
}
const sampleOdt = () => odt('<text:h text:outline-level="1">Meeting Notes</text:h><text:p>We agreed on the <text:span text:style-name="T1">budget</text:span>.</text:p><text:list><text:list-item><text:p>Order parts</text:p></text:list-item><text:list-item><text:p>Book the room</text:p></text:list-item></text:list><table:table><table:table-row><table:table-cell><text:p>Who</text:p></table:table-cell><table:table-cell><text:p>What</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell><text:p>Ana</text:p></table:table-cell><table:table-cell><text:p>Parts</text:p></table:table-cell></table:table-row></table:table>');

// ---------------- EPUB ----------------
function epub(chapters, { title = 'A Short Book', images = {} } = {}) {
  const files = [
    ['mimetype', 'application/epub+zip', { store: true }],
    ['META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ['OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title)}</dc:title></metadata><manifest>${chapters.map((c, i) => `<item id="c${i}" href="text/ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('')}${Object.keys(images).map((n, i) => `<item id="i${i}" href="${n}" media-type="image/png"/>`).join('')}</manifest><spine>${chapters.map((c, i) => `<itemref idref="c${i}"/>`).join('')}</spine></package>`],
  ];
  chapters.forEach((c, i) => files.push([`OEBPS/text/ch${i + 1}.xhtml`, `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>${c}</body></html>`]));
  for (const [n, b] of Object.entries(images)) files.push([`OEBPS/${n}`, b]);
  return zip(files);
}
const sampleEpub = () => epub(['<h1>Chapter One</h1><p>It was a <em>quiet</em> morning.</p><img src="../images/cover.png" alt="Cover art"/>', '<h1>Chapter Two</h1><ul><li>Bread</li><li>Milk</li></ul>'], { images: { 'images/cover.png': png(8, 8) } });

// ---------------- RTF, HTML, CSV ----------------
const sampleRtf = () => Buffer.from('{\\rtf1\\ansi\\ansicpg1252{\\fonttbl{\\f0 Arial;}}\\f0 Letter to the board\\par We thank you for your {\\b support} this year.\\par Caf\\\'e9 opens in May.\\par}', 'latin1');
const sampleHtml = () => Buffer.from(`<!doctype html><html><head><title>Release notes</title><style>p{color:red}</style><script>window.bad = 1</script></head><body>
<h1>Release notes</h1><p>Version <strong>2.0</strong> adds <em>search</em> and <a href="https://example.com/docs">docs</a>.</p>
<h2>Changes</h2><ol><li>Faster start</li><li>New icons<ul><li>dark</li><li>light</li></ul></li></ol>
<pre><code class="language-js">const x = 1;\nconsole.log(x);</code></pre>
<table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody><tr><td>a|b</td><td>1</td></tr></tbody></table>
<blockquote><p>Quoted line</p></blockquote><p>Inline <code>code</code> and &lt;not a tag&gt;.</p><img src="data:image/png;base64,iVBORw0KGgo=" alt="Logo"></body></html>`, 'utf8');
const sampleCsv = () => Buffer.from('name,qty,note\napple,3,"red, sweet"\npear,5,"has | pipe"\n', 'utf8');

module.exports = { zip, crc32, png, pdf, samplePdf, docx, wp, wr, wli, wimg, sampleDocx, pptx, sp, pic, tbl, samplePptx, xlsx, sampleXlsx, odt, sampleOdt, epub, sampleEpub, sampleRtf, sampleHtml, sampleCsv, esc };
