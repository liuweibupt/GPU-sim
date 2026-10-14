import {readFile} from 'node:fs/promises';
import {traceBounds} from '../lib/trace.js';
import {normalizeRun} from '../lib/run-state.js';
try {
  const paths = process.argv.slice(2);
  if (!paths.length) throw new Error('Usage: node scripts/validate-trace.mjs <trace.json> [trace.json ...]');
  for (const path of paths) {
    const trace = normalizeRun(JSON.parse(await readFile(path, 'utf8')));
    console.log(JSON.stringify({path, events:trace.events.length, components:trace.components.length, evidence:trace.meta.evidenceKind, timeUnit:trace.meta.timeUnit, ...traceBounds(trace)}, null, 2));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
