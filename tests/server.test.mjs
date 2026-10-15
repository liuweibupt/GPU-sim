import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('documented entrypoint, module and sample are served; repository metadata is inaccessible', async t => {
  const server = spawn(process.execPath, ['scripts/serve.mjs'], {
    cwd: new URL('..', import.meta.url), env: {...process.env, PORT:'0'}, stdio:['ignore','pipe','pipe']
  });
  t.after(() => server.kill());
  const [chunk] = await once(server.stdout,'data');
  const base = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(base, chunk.toString());
  const page = await fetch(base + '/');
  assert.equal(page.status,200);
  assert.match(await page.text(), /<title>/);
  for (const path of ['/web/app.js','/lib/trace.js','/examples/gtsim-gemm.json','/examples/flashgpu-vectoradd.json','/examples/flashgpu-vectoradd-pipeline.json','/lib/native-pipeline.js','/lib/instruction-view.js']) {
    assert.equal((await fetch(base + path)).status,200,path);
  }
  const asset = await fetch(base + '/web/assets/gpu/sm.png',{method:'HEAD'});
  assert.equal(asset.status,200);
  assert.equal(asset.headers.get('content-type'),'image/png');
  assert.equal((await fetch(base + '/.git/config')).status,404);
  assert.equal((await fetch(base + '/web/%2e%2e/%2e%2e/.git/config')).status,404);
});
