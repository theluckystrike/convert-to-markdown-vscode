'use strict';
// Runs the converters in a worker thread, so a hostile or huge file can never block or crash the extension host.
// The host (runner.js) kills this worker when it takes too long, uses too much memory, or the user cancels.
// Bundled with esbuild into dist/worker.js together with mammoth, SheetJS, parse5 and fflate; pdf.js stays as its own
// ES module files in dist/pdfjs and is loaded on the first PDF.
const fs = require('fs');
const path = require('path');
const { parentPort } = require('worker_threads');
const { convert } = require('./core/convert');

function pdfjsDirs(job) {
  if (job.pdfjs) return job.pdfjs;
  const base = path.join(__dirname, 'pdfjs');
  return { lib: path.join(base, 'pdf.min.mjs'), worker: path.join(base, 'pdf.worker.min.mjs'), cmaps: path.join(base, 'cmaps') };
}

async function run(job, progress) {
  if (job.op !== 'convert') throw new Error(`unknown job ${job.op}`);
  let buf;
  if (job.buffer) buf = Buffer.from(job.buffer);
  else {
    const st = fs.statSync(job.file);
    if (job.maxBytes && st.size > job.maxBytes) { const e = new Error(`TOO_BIG ${st.size}`); e.code = 'TOO_BIG'; e.size = st.size; throw e; }
    buf = fs.readFileSync(job.file);
  }
  let last = 0;
  const r = await convert(buf, {
    name: job.name, images: job.images, assetsDir: job.assetsDir, limits: job.limits, pdfjs: pdfjsDirs(job),
    progress: (message, fraction) => { const now = Date.now(); if (now - last > 150) { last = now; progress({ message, fraction }); } },
  });
  return r;
}

parentPort.on('message', async (msg) => {
  try {
    const result = await run(msg.job, (p) => parentPort.postMessage({ id: msg.id, progress: p }));
    parentPort.postMessage({ id: msg.id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, ok: false, error: String((e && e.message) || e), code: e && e.code, size: e && e.size });
  }
});
