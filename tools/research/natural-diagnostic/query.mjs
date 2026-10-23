#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {queryDiagnostic} from '../../../lib/research/natural-diagnostic.js';
const [path, request] = process.argv.slice(2);
if (!path || !request) throw Error('Usage: node query.mjs DATA_JSON QUERY_JSON');
process.stdout.write(JSON.stringify(queryDiagnostic(JSON.parse(await readFile(path, 'utf8')), JSON.parse(request))) + '\n');
