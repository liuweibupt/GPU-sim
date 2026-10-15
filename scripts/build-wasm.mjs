import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {accessSync, constants} from 'node:fs';
import {chmod} from 'node:fs/promises';
import {delimiter, join} from 'node:path';

const source = fileURLToPath(new URL('../lib/interval-query.c', import.meta.url));
const output = fileURLToPath(new URL('../lib/interval-query.wasm', import.meta.url));
const compiler = process.env.WASM_CC || 'clang';
const linker = process.env.WASM_LD || ['wasm-ld', 'wasm-ld-20', 'wasm-ld-19', 'wasm-ld-18', 'wasm-ld-17']
  .flatMap(name => (process.env.PATH || '').split(delimiter).map(directory => join(directory, name)))
  .find(path => {try {accessSync(path, constants.X_OK); return true;} catch {return false;}});
const result = spawnSync(compiler, ['--target=wasm32', '-O3', '-nostdlib',
  '-Wl,--no-entry', '-Wl,--import-memory', '-Wl,--export=query_intervals',
  '-Wl,--export=__heap_base', '-Wl,-z,stack-size=4096', '-Wl,--strip-all',
  ...(linker ? [`-fuse-ld=${linker}`] : []),
  source, '-o', output], {stdio: 'inherit'});
if (result.error) console.error(result.error.message);
if (result.status !== 0) process.exit(result.status || 1);
await chmod(output, 0o644);
console.log(`WASM interval engine built: ${output}`);
