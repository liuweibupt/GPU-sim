import {readFile} from 'node:fs/promises';
import {normalizeTrace, traceBounds} from '../lib/trace.js';
try {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: node scripts/validate-trace.mjs <trace.json>');
  const trace = normalizeTrace(JSON.parse(await readFile(path, 'utf8')));
  console.log(JSON.stringify({path, events:trace.events.length, components:trace.components.length, evidence:trace.meta.evidenceKind, timeUnit:trace.meta.timeUnit, ...traceBounds(trace)}, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
