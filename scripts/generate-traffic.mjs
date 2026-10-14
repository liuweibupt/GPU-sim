import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {simulateTraffic} from '../lib/traffic-model.js';
import {validateTrafficTrace} from '../lib/traffic-contract.js';

const directory = new URL('../examples/', import.meta.url);
for (const [name, config] of [['h100-traffic.json', {}], ['h100-traffic-slow-noc.json', {nocBytesPerCycle: 16}]]) {
  const trace = validateTrafficTrace(simulateTraffic(config));
  const output = new URL(name, directory);
  await writeFile(output, JSON.stringify(trace) + '\n');
  console.log(`${fileURLToPath(output)}: ${trace.events.length} spans, ${trace.metrics.traffic.completedTasks} tiles, ${trace.metrics.traffic.makespan} modeled cycles`);
}
