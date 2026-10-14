import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {simulateSm} from '../lib/sm-model.js';
import {validateSmTrace} from '../lib/sm-contract.js';

for (const [name, config] of [['h100-sm.json', {}], ['h100-sm-bank-conflict.json', {sharedBankStrideWords: 32}]]) {
  const trace = validateSmTrace(simulateSm(config));
  const output = new URL(`../examples/${name}`, import.meta.url);
  await writeFile(output, JSON.stringify(trace) + '\n');
  console.log(`${fileURLToPath(output)}: ${trace.events.length} stages, ${trace.metrics.sm.completedInstructions} synthetic instructions, ${trace.metrics.sm.makespan} teaching cycles`);
}
