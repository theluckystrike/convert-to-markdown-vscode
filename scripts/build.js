'use strict';
// Bundles src/worker.js (converters + mammoth, SheetJS, parse5, fflate, word-extractor) into dist/worker.js with
// esbuild, and copies the pdf.js legacy build (pdf.min.mjs, pdf.worker.min.mjs, cmaps) into dist/pdfjs.
// The libraries come read-only from node_modules trees that other Zovo products already have (no npm install here):
// NODE_PATH-style lookup through esbuild's nodePaths. Writes dist/bundled.json (package, version, licence) for the
// THIRD-PARTY-NOTICES file.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PRODUCTS = path.join(ROOT, '..');
const TREES = ['docx-viewer-vscode', 'table-viewer-vscode', 'archive-explorer-vscode', 'pdf-viewer-vscode'].map((p) => path.join(PRODUCTS, p, 'node_modules'));
const PDFJS = path.join(PRODUCTS, 'pdf-viewer-vscode', 'node_modules', 'pdfjs-dist');
const esbuild = require(path.join(PRODUCTS, 'docx-viewer-vscode', 'node_modules', 'esbuild'));

async function main() {
  const dist = path.join(ROOT, 'dist');
  fs.mkdirSync(path.join(dist, 'pdfjs', 'cmaps'), { recursive: true });
  const r = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'worker.js')],
    bundle: true, platform: 'node', format: 'cjs', target: 'node18', minify: true, legalComments: 'none',
    outfile: path.join(dist, 'worker.js'), nodePaths: TREES, metafile: true, logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const pkgs = new Map();
  for (const input of Object.keys(r.metafile.inputs)) {
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (!m) continue;
    const abs = path.resolve(input);
    const root = abs.slice(0, abs.lastIndexOf('node_modules/') + 'node_modules/'.length + m[1].length);
    if (pkgs.has(m[1])) continue;
    const pj = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    pkgs.set(m[1], { name: m[1], version: pj.version, license: pj.license || (pj.licenses && pj.licenses.map((l) => l.type).join(' OR ')) || '', root });
  }
  for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) fs.copyFileSync(path.join(PDFJS, 'legacy', 'build', f), path.join(dist, 'pdfjs', f));
  for (const f of fs.readdirSync(path.join(PDFJS, 'cmaps'))) if (f.endsWith('.bcmap')) fs.copyFileSync(path.join(PDFJS, 'cmaps', f), path.join(dist, 'pdfjs', 'cmaps', f));
  const pj = JSON.parse(fs.readFileSync(path.join(PDFJS, 'package.json'), 'utf8'));
  pkgs.set('pdfjs-dist', { name: 'pdfjs-dist', version: pj.version, license: pj.license, root: PDFJS });
  const list = [...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(path.join(dist, 'bundled.json'), JSON.stringify(list.map(({ root, ...x }) => x), null, 1));
  const bad = list.filter((p) => !/^(MIT|BSD-2-Clause|BSD-3-Clause|Apache-2.0|ISC|\(MIT OR GPL-3.0-or-later\)|MIT OR GPL-3.0-or-later|\(MIT AND Zlib\)|Zlib|BlueOak-1.0.0)$/.test(p.license));
  if (bad.length) { console.error('licence check failed:', bad); process.exit(1); }
  console.log(`dist/worker.js ${(fs.statSync(path.join(dist, 'worker.js')).size / 1024).toFixed(0)} KB, ${list.length} packages: ${list.map((p) => `${p.name}@${p.version} (${p.license})`).join(', ')}`);
  return [...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { main, TREES };
