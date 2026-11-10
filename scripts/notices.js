'use strict';
// Writes THIRD-PARTY-NOTICES.txt from the packages esbuild put into dist/worker.js (and pdf.js in dist/pdfjs):
// name, version, licence and the full licence text of each.
const fs = require('fs');
const path = require('path');
const { main } = require('./build');

(async () => {
  const list = await main();
  const out = ['Third-party software in Convert to Markdown', '', 'dist/worker.js bundles the packages below (esbuild); dist/pdfjs holds the pdf.js legacy build. Each is used under the licence named here. For jszip, which is offered under MIT or GPL-3.0, the MIT licence is used.', ''];
  for (const p of list) {
    const lic = fs.readdirSync(p.root).find((f) => /^(licen[cs]e|copying)(\.md|\.txt|\.markdown)?$/i.test(f));
    out.push('='.repeat(78), `${p.name} ${p.version} (${p.license})`, '='.repeat(78));
    const mitText = 'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.';
    const author = (() => { try { const a = require(path.join(p.root, 'package.json')).author; return typeof a === 'string' ? a : (a && a.name) || ''; } catch { return ''; } })();
    out.push(lic ? fs.readFileSync(path.join(p.root, lic), 'utf8').trim() : `The MIT License. Copyright (c) ${author || 'the ' + p.name + ' authors'}. The package ships no licence file; its package.json names the MIT licence:\n\n${mitText}`, '');
  }
  fs.writeFileSync(path.join(__dirname, '..', 'THIRD-PARTY-NOTICES.txt'), out.join('\n') + '\n');
  console.log('THIRD-PARTY-NOTICES.txt', list.length, 'packages');
})();
