'use strict';
// Which converter reads a file: decided by its bytes first, then by its extension. No dependencies, so the extension
// host can load it to filter files without loading the converters.
const path = require('path');

const EXTENSIONS = ['pdf', 'docx', 'docm', 'dotx', 'dotm', 'doc', 'dot', 'odt', 'ott', 'rtf', 'pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'xlsx', 'xlsm', 'xlsb', 'xls', 'ods', 'csv', 'tsv', 'html', 'htm', 'xhtml', 'epub'];
const EXT_RE = new RegExp(`\\.(${EXTENSIONS.join('|')})$`, 'i');

const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const startsWith = (b, m) => b.length >= m.length && m.every((x, i) => b[i] === x);

function u16le(s) { const b = Buffer.alloc(s.length * 2); for (let i = 0; i < s.length; i++) b.writeUInt16LE(s.charCodeAt(i), i * 2); return b; }
const OLE_NAMES = { encrypted: u16le('EncryptedPackage'), doc: u16le('WordDocument'), xls: u16le('Workbook'), xls5: u16le('Book'), ppt: u16le('PowerPoint Document') };

/** Names of the entries in a ZIP file, from its central directory (no inflating). At most 100,000 names. */
function zipNames(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const min = Math.max(0, b.length - 65557);
  let eocd = -1;
  for (let i = b.length - 22; i >= min; i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  let count = b.readUInt16LE(eocd + 10);
  let off = b.readUInt32LE(eocd + 16);
  const names = [];
  let total = 0, maxXml = 0;
  if (count === 0xffff || off === 0xffffffff) count = 100000; // ZIP64: walk until the signature stops
  for (let i = 0; i < count && i < 100000; i++) {
    if (off + 46 > b.length || b.readUInt32LE(off) !== 0x02014b50) break;
    const n = b.readUInt16LE(off + 28), x = b.readUInt16LE(off + 30), c = b.readUInt16LE(off + 32);
    const size = b.readUInt32LE(off + 24);
    const name = b.toString('utf8', off + 46, Math.min(b.length, off + 46 + n));
    names.push(name);
    total += size;
    if (/\.(xml|x?html?|rels)$/i.test(name) && size > maxXml) maxXml = size;
    off += 46 + n + x + c;
  }
  names.total = total;
  names.maxXml = maxXml;
  return names;
}

function storedText(buf, entry) {
  // 'mimetype' is stored uncompressed first in ODF and EPUB files.
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length > 38 && b.readUInt32LE(0) === 0x04034b50 && b.readUInt16LE(8) === 0) {
    const n = b.readUInt16LE(26), x = b.readUInt16LE(28), size = b.readUInt32LE(18);
    if (b.toString('utf8', 30, 30 + n) === entry && size < 200) return b.toString('utf8', 30 + n + x, 30 + n + x + size);
  }
  return '';
}

/**
 * kind: pdf docx pptx xlsx xls ods odt epub rtf html csv tsv doc
 *   or a refusal: empty encrypted ppt-legacy odp unknown zip-unknown zip-bomb
 */
function detect(buf, name) {
  const ext = path.extname(String(name || '')).toLowerCase().replace('.', '');
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
  if (!b.length) return { kind: 'empty', ext };
  const head = b.subarray(0, 1024).toString('latin1');
  if (head.includes('%PDF-')) return { kind: 'pdf', ext };
  if (b[0] === 0x50 && b[1] === 0x4b) {
    const names = zipNames(b);
    if (!names) return { kind: 'unknown', ext, why: 'damaged-zip' };
    const has = (n) => names.includes(n);
    const mime = storedText(b, 'mimetype');
    if ((names.total > 1024 * 1024 * 1024 && names.total > b.length * 50) || names.maxXml > 200 * 1024 * 1024) return { kind: 'zip-bomb', ext, unpacked: names.total };
    if (has('word/document.xml') || names.some((n) => /^word\/document\d*\.xml$/.test(n))) return { kind: 'docx', ext, xmlTotal: names.total };
    if (has('ppt/presentation.xml')) return { kind: 'pptx', ext };
    if (has('xl/workbook.xml') || has('xl/workbook.bin')) return { kind: 'xlsx', ext };
    if (/opendocument\.text/.test(mime) || (!mime && (ext === 'odt' || ext === 'ott') && has('content.xml'))) return { kind: 'odt', ext };
    if (/opendocument\.spreadsheet/.test(mime)) return { kind: 'ods', ext };
    if (/opendocument\.presentation/.test(mime)) return { kind: 'odp', ext };
    if (mime === 'application/epub+zip' || has('META-INF/container.xml')) return { kind: 'epub', ext };
    return { kind: 'zip-unknown', ext };
  }
  if (startsWith(b, OLE)) {
    if (b.indexOf(OLE_NAMES.encrypted) >= 0) return { kind: 'encrypted', ext };
    if (b.indexOf(OLE_NAMES.doc) >= 0) return { kind: 'doc', ext };
    if (b.indexOf(OLE_NAMES.xls) >= 0 || b.indexOf(OLE_NAMES.xls5) >= 0) return { kind: 'xls', ext };
    if (b.indexOf(OLE_NAMES.ppt) >= 0) return { kind: 'ppt-legacy', ext };
    return { kind: 'unknown', ext, why: 'ole' };
  }
  if (/^\s*\{\\rtf/.test(head)) return { kind: 'rtf', ext };
  if (ext === 'csv') return { kind: 'csv', ext };
  if (ext === 'tsv' || ext === 'tab') return { kind: 'tsv', ext };
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml' || /^(﻿|\xef\xbb\xbf)?\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(!doctype\s+html|html)/i.test(head)) return { kind: 'html', ext };
  return { kind: 'unknown', ext };
}

const REFUSALS = {
  empty: 'The file is empty (0 bytes).',
  encrypted: 'This file is password-protected. Open it in Word, Excel or PowerPoint, remove the password, save it and convert it again.',
  'ppt-legacy': 'This is an old PowerPoint 97-2003 file (.ppt). Save it as .pptx in PowerPoint, Keynote or LibreOffice and convert that file.',
  odp: 'OpenDocument presentations (.odp) are not supported yet. Save the file as .pptx and convert that file.',
  'zip-bomb': 'This file unpacks to far more than its own size (one XML part over 200 MB, or more than 1 GB in all): a ZIP bomb or a damaged file. It was not converted.',
  'zip-unknown': 'This ZIP file is not a Word, PowerPoint, Excel, OpenDocument or EPUB file.',
  unknown: 'This file is not one of the supported formats (PDF, Word, PowerPoint, Excel, CSV, HTML, EPUB, ODT, RTF), or it is damaged.',
};

module.exports = { detect, zipNames, EXTENSIONS, EXT_RE, REFUSALS };
