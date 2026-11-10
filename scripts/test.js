'use strict';
// npm test: bundles dist/worker.js (scripts/build.js), then runs every test/*.test.js with the Node test runner.
// The converter libraries resolve read-only from the node_modules trees of other Zovo products (NODE_PATH); nothing
// is installed here and no test uses the network.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { TREES } = require('./build');
const b = spawnSync(process.execPath, [path.join(__dirname, 'build.js')], { stdio: 'inherit' });
if (b.status !== 0) process.exit(b.status || 1);
const dir = path.join(__dirname, '..', 'test');
const only = process.argv.slice(2);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js') && (!only.length || only.some((o) => f.includes(o)))).map((f) => path.join(dir, f));
const env = { ...process.env, NODE_PATH: TREES.join(path.delimiter), ZOVO_SPONSORS_MODULE: path.join(__dirname, '..', 'src', 'license', 'sponsors.js') };
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=2', ...files], { stdio: 'inherit', env });
process.exit(r.status === null ? 1 : r.status);
