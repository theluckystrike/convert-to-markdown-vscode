'use strict';
// Images found while converting. In 'placeholder' mode (free) an image becomes "*[Image: alt text]*" and no bytes are
// kept. In 'collect' mode (Zovo Pro: Extract images) the bytes are kept and the Markdown links to
// "<assets dir>/image-001.png" relative to the .md file.
const M = require('./md');

const MAX_IMAGES = 2000;
const MAX_TOTAL = 512 * 1024 * 1024;

function sniffExt(b) {
  if (!b || b.length < 4) return '';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (b.length > 12 && Buffer.from(b.subarray(0, 4)).toString('latin1') === 'RIFF' && Buffer.from(b.subarray(8, 12)).toString('latin1') === 'WEBP') return 'webp';
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 42) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 42)) return 'tif';
  if (b.length >= 44 && b[0] === 1 && b[1] === 0 && b[2] === 0 && b[3] === 0 && b[40] === 0x20 && b[41] === 0x45 && b[42] === 0x4d && b[43] === 0x46) return 'emf';
  if (b[0] === 0xd7 && b[1] === 0xcd && b[2] === 0xc6 && b[3] === 0x9a) return 'wmf';
  const head = Buffer.from(b.subarray(0, 256)).toString('utf8');
  if (/<svg[\s>]/i.test(head)) return 'svg';
  return '';
}

class Assets {
  constructor(mode = 'placeholder', dir = 'assets') {
    this.mode = mode;
    this.dir = dir;
    this.files = []; // { name, data }
    this.count = 0;
    this.total = 0;
    this.skipped = 0;
  }

  get collecting() { return this.mode === 'collect'; }

  placeholder(alt) {
    const a = String(alt || '').replace(/\s+/g, ' ').trim();
    return `*[Image${a ? `: ${M.escapeText(a)}` : ''}]*`;
  }

  /** bytes: Uint8Array or Buffer, or null. Returns the Markdown for the image. */
  add(bytes, alt, hintExt) {
    this.count++;
    if (!this.collecting || !bytes || !bytes.length) return this.placeholder(alt);
    if (this.files.length >= MAX_IMAGES || this.total + bytes.length > MAX_TOTAL) { this.skipped++; return this.placeholder(alt); }
    const ext = sniffExt(bytes) || String(hintExt || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'bin';
    const name = `image-${String(this.files.length + 1).padStart(3, '0')}.${ext}`;
    this.files.push({ name, data: Buffer.from(bytes.buffer ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes) });
    this.total += bytes.length;
    const a = String(alt || '').replace(/\s+/g, ' ').replace(/[[\]\\]/g, '').trim() || `Image ${this.files.length}`;
    return `![${a}](${encodeURI(`${this.dir}/${name}`).replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29'))})`;
  }

  /** For data: URIs (ODT and HTML) */
  addDataUri(uri, alt) {
    const m = /^data:([\w/+.-]+)?(;base64)?,(.*)$/s.exec(String(uri || ''));
    if (!m) return this.placeholder(alt);
    if (!this.collecting) { this.count++; return this.placeholder(alt); }
    const bytes = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
    return this.add(bytes, alt, (m[1] || '').split('/')[1]);
  }
}

module.exports = { Assets, sniffExt };
