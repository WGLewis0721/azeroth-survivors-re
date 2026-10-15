import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../mobile.js', import.meta.url), 'utf8');
const { stickVector, wantsMobile, configureMobile } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

test('thumbstick deadzone, analog speed, diagonals, and drag bounds', () => {
  assert.deepEqual(stickVector(0, 0), { x: 0, y: 0 });
  assert.deepEqual(stickVector(4, 0), { x: 0, y: 0 });
  const half = stickVector(28, 0);
  assert.ok(half.x > .4 && half.x < .5);
  assert.equal(half.y, 0);
  const diagonal = stickVector(200, -200);
  assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.y) - 1) < 1e-9);
  assert.ok(diagonal.x > 0 && diagonal.y < 0);
});
test('touch defaults and explicit desktop/mobile overrides', () => {
  assert.equal(wantsMobile('', true), true);
  assert.equal(wantsMobile('', false), false);
  assert.equal(wantsMobile('?mobile=1', false), true);
  assert.equal(wantsMobile('?mobile=0', true), false);
});
test('mobile budget preserves explicit query and hosting settings', () => {
  assert.deepEqual(configureMobile({}, ''), { renderscale: '0.65', farclip: '150', worlddetail: '0' });
  const env = configureMobile({ farclip: '220' }, '?renderScale=0.9');
  assert.equal(env.farclip, '220');
  assert.equal(env.renderscale, undefined);
  assert.equal(env.worlddetail, '0');
});
test('packaging includes all mobile runtime files and portrait manifest', async () => {
  const build = await readFile(new URL('../../scripts/web-build.sh', import.meta.url), 'utf8');
  for (const file of ['mobile.js', 'mobile.css', 'manifest.webmanifest']) assert.ok(build.includes(`web/${file}`));
  const manifest = JSON.parse(await readFile(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.orientation, 'portrait-primary');
  assert.equal(manifest.display, 'standalone');
});

const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const shaderHook = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(script => script.includes('createShaderModule'));

function installShaderHook(createShaderModule) {
  const warnings = [], errors = [];
  class GPUDevice {}
  GPUDevice.prototype.createShaderModule = createShaderModule;
  vm.runInNewContext(shaderHook, {
    navigator: { gpu: {} }, window: { GPUDevice }, GPUDevice,
    console: { warn: (...args) => warnings.push(args), error: (...args) => errors.push(args) },
  });
  return { device: new GPUDevice(), warnings, errors };
}

test('missing shader diagnostics still returns the original shader module', () => {
  const module = {};
  const { device } = installShaderHook(() => module);
  assert.equal(device.createShaderModule({ code: '' }), module);
});

for (const failure of ['throw', 'reject']) {
  test(`optional shader diagnostics cannot break startup (${failure})`, async () => {
    const module = {
      getCompilationInfo() {
        if (failure === 'throw') throw new Error('diagnostics unsupported');
        return Promise.reject(new Error('diagnostics unsupported'));
      },
    };
    const { device, warnings } = installShaderHook(() => module);
    assert.equal(device.createShaderModule({ code: '' }), module);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0][1], /diagnostics unsupported/);
  });
}

test('shader diagnostics still reports compilation errors', async () => {
  const module = { getCompilationInfo: async () => ({
    messages: [{ type: 'error', lineNum: 1, linePos: 2, message: 'invalid shader' }],
  }) };
  const { device, errors } = installShaderHook(() => module);
  assert.equal(device.createShaderModule({ label: 'terrain', code: 'bad code' }), module);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /terrain @1:2: invalid shader\n    bad code/);
});

test('actual shader creation failures are not swallowed by diagnostics', () => {
  const { device } = installShaderHook(() => { throw new Error('device lost'); });
  assert.throws(() => device.createShaderModule({ code: '' }), /device lost/);
});
