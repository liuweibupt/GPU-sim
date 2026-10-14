import {cp, mkdir, readdir, rm, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const root = new URL('../', import.meta.url);
const output = new URL('dist/', root);

// Preserve the source layout: web/app.js imports ../lib/trace.js and fetches
// ../examples/*.json. Relative URLs also work under GitHub Pages' /GPU-sim/.
await rm(output, {recursive: true, force: true});
await mkdir(output, {recursive: true});
for (const directory of ['web', 'lib']) {
  await cp(new URL(directory, root), new URL(directory, output), {
    recursive: true,
    dereference: true,
  });
}

await mkdir(new URL('examples/', output));
for (const entry of await readdir(new URL('examples/', root), {withFileTypes: true})) {
  if (entry.isFile() && entry.name.endsWith('.json')) {
    await cp(new URL(`examples/${entry.name}`, root), new URL(`examples/${entry.name}`, output));
  }
}

await writeFile(new URL('index.html', output), `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="0; url=./web/" />
    <title>GPU 计算城市</title>
  </head>
  <body><p><a href="./web/">进入 GPU 计算城市</a></p></body>
</html>
`);
await writeFile(new URL('.nojekyll', output), '');
console.log(`Static site built: ${fileURLToPath(output)}`);
