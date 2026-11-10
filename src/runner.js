'use strict';
// Starts a worker thread per conversion, with a memory cap and a watchdog. A job that sends nothing for `idleMs` is
// killed and rejected with code 'TIMEOUT'; a worker that runs out of memory is rejected with code 'MEMORY'; cancel()
// kills it at once ('CANCELLED'). The extension host keeps running either way.
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const WORKER = process.env.ZOVO_TOMD_WORKER || path.join(__dirname, '..', 'dist', 'worker.js');
const MEMORY_MB = 2048;

function runJob(job, { idleMs = 60000, onProgress, transfer, token } = {}) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(WORKER)) { reject(new Error(`The converter is missing (${WORKER}). Reinstall the extension.`)); return; }
    let w;
    try { w = new Worker(WORKER, { resourceLimits: { maxOldGenerationSizeMb: MEMORY_MB, maxYoungGenerationSizeMb: 64 } }); } catch (e) { reject(e); return; }
    let done = false, timer, sub;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); if (sub) sub.dispose(); w.terminate().catch(() => {}); fn(v); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { const e = new Error(`Converting took longer than ${Math.round(idleMs / 1000)} seconds without progress and was stopped.`); e.code = 'TIMEOUT'; finish(reject, e); }, idleMs); };
    arm();
    if (token) {
      const cancel = () => { const e = new Error('Cancelled.'); e.code = 'CANCELLED'; finish(reject, e); };
      if (token.isCancellationRequested) { cancel(); return; }
      sub = token.onCancellationRequested(cancel);
    }
    w.on('message', (m) => {
      if (m.progress) { arm(); try { if (onProgress) onProgress(m.progress); } catch { /* ignore */ } return; }
      if (m.ok) finish(resolve, m.result);
      else { const e = new Error(m.error); e.code = m.code; e.size = m.size; finish(reject, e); }
    });
    w.on('error', (err) => {
      const oom = err && err.code === 'ERR_WORKER_OUT_OF_MEMORY';
      const e = new Error(oom ? `Converting needed more than ${MEMORY_MB} MB of memory and was stopped.` : String((err && err.message) || err));
      e.code = oom ? 'MEMORY' : 'WORKER';
      finish(reject, e);
    });
    w.on('exit', (code) => { if (!done) { const e = new Error(`The converter stopped (exit code ${code}).`); e.code = 'WORKER'; finish(reject, e); } });
    w.postMessage({ id: 1, job }, transfer || []);
  });
}

module.exports = { runJob, WORKER, MEMORY_MB };
