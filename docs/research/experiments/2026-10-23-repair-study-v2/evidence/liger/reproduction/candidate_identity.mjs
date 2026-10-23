/** Match the frozen study's localeCompare serialization exactly across adapters. */
import {createHash} from 'node:crypto';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const files = JSON.parse(input);
const entries = files.map(({path, sha256}) => ({path, sha256})).sort((a, b) => a.path.localeCompare(b.path));
process.stdout.write(createHash('sha256').update(JSON.stringify(entries)).digest('hex') + '\n');
