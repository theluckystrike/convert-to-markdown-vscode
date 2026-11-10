'use strict';
// Writes the 3 walkthrough samples (built in code, no third-party content): samples/sample-plan.docx,
// sample-report.pdf, sample-slides.pptx.
const fs = require('fs');
const path = require('path');
const B = require('../test/build');
const dir = path.join(__dirname, '..', 'samples');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'sample-plan.docx'), B.sampleDocx());
fs.writeFileSync(path.join(dir, 'sample-report.pdf'), B.samplePdf());
fs.writeFileSync(path.join(dir, 'sample-slides.pptx'), B.samplePptx());
console.log(fs.readdirSync(dir).join(' '));
