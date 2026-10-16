import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (await readFile(new URL('../boot.js', import.meta.url), 'utf8'))
  .replaceAll('import.meta.url', JSON.stringify(new URL('../boot.js', import.meta.url).href));
const { boot } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const wasmBytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

function setup(t, fetch) {
  const children = new Map();
  const element = () => ({
    style: { setProperty() {} }, classList: { add() {} }, remove() {}, appendChild() {},
    querySelector(selector) {
      if (!children.has(selector)) children.set(selector, element());
      return children.get(selector);
    },
  });
  for (const [key, value] of Object.entries({
    fetch, location: { search: '' }, window: {},
    document: { createElement: element, body: { appendChild() {} } },
    setTimeout: () => 0, clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {},
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  }
  return children;
}

for (const mime of ['application/wasm', 'application/octet-stream', 'application/wasm; charset=utf-8']) {
  test(`compilation overlaps prefetch and init waits (${mime})`, async t => {
    const manifest = deferred();
    const compiled = deferred();
    const original = WebAssembly[mime === 'application/wasm' ? 'compileStreaming' : 'compile'];
    const method = mime === 'application/wasm' ? 'compileStreaming' : 'compile';
    t.mock.method(WebAssembly, method, async input => {
      const module = await original.call(WebAssembly, input);
      compiled.resolve();
      return module;
    });
    setup(t, async url => String(url).endsWith('boot-manifest.json') ? manifest.promise :
      new Response(wasmBytes, { headers: { 'content-type': mime } }));
    let started = false;
    const result = boot(async ({ module_or_path }) => {
      started = true;
      assert.ok(module_or_path instanceof WebAssembly.Module);
      return { memory: 'bound by caller' };
    });
    await compiled.promise;
    assert.equal(started, false);
    manifest.resolve(new Response(JSON.stringify({ names: [] })));
    assert.deepEqual(await result, { memory: 'bound by caller' });
  });
}

test('download failure is reported while prefetch is still pending', async t => {
  const manifest = deferred();
  const children = setup(t, async url => String(url).endsWith('boot-manifest.json') ? manifest.promise :
    new Response('unavailable', { status: 503 }));
  await assert.rejects(boot(() => assert.fail('must not initialize')), /HTTP 503/);
  assert.match(children.get('.stage').textContent, /client failed to start.*HTTP 503/);
  manifest.resolve(new Response('{}'));
});

test('missing manifest degrades to ordinary startup', async t => {
  setup(t, async url => String(url).endsWith('boot-manifest.json') ? new Response('', { status: 404 }) :
    new Response(wasmBytes, { headers: { 'content-type': 'application/wasm' } }));
  assert.equal(await boot(async () => 'started'), 'started');
});

test('invalid wasm reports compilation failure and never starts the client', async t => {
  const children = setup(t, async url => String(url).endsWith('boot-manifest.json') ? new Response('{}') :
    new Response('invalid', { headers: { 'content-type': 'application/wasm' } }));
  await assert.rejects(boot(() => assert.fail('must not initialize')), WebAssembly.CompileError);
  assert.match(children.get('.stage').textContent, /client failed to start/);
});

test('gzip parts compile one at a time and are handed to init before start', async t => {
  const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const gz = await new Response(new Blob([wasm]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  const compiled = [];
  const original = WebAssembly.compile;
  t.mock.method(WebAssembly, 'compile', async buf => {
    compiled.push(buf.byteLength);
    return original.call(WebAssembly, buf);
  });
  setup(t, async url => {
    const name = String(url);
    if (name.endsWith('boot-manifest.json')) return new Response('{}');
    if (name.includes('/snippets/wenilla-03/')) return new Response('', { status: 404 });
    if (name.includes('/snippets/wenilla-')) return new Response(gz);
    return new Response(wasm, { headers: { 'content-type': 'application/octet-stream' } });
  });
  assert.equal(await boot(async ({ module_or_path }) => {
    assert.ok(module_or_path instanceof WebAssembly.Module);
    let count = 0;
    for (let i = 0; ; i++) {
      const part = await globalThis.__wenilla_load_part(i);
      if (!part) break;
      count++;
    }
    assert.equal(count, 3);
    return 'linked';
  }), 'linked');
  assert.deepEqual(compiled, [8, 8, 8, 8]);
});
