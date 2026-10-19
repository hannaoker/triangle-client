import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.mjs';
const io = { stdout() {}, stderr() {} };
test('service commands route bounded public options without opening owner custody', async () => {
  let received;
  const result = await main(['service', 'retry', '--profile', 'linux-agent', '--delivery', 'delivery-1', '--yes'], { io, serviceDependencies: { service: { retry: async value => { received = value; return { profile: value.profile, state: 'retry_requested' }; } } } });
  assert.equal(result, 0);
  assert.deepEqual(received, { profile: 'linux-agent', delivery: 'delivery-1', yes: true });
});
test('service invalid profile and irrelevant mutation options fail before service access', async () => {
  assert.equal(await main(['service', 'status', '--profile', '../bad'], { io }), 2);
  assert.equal(await main(['service', 'status', '--profile', 'valid', '--yes'], { io }), 2);
});
test('service doctor reports unready runtime with failure exit', async () => {
  assert.equal(await main(['service', 'doctor', '--profile', 'valid'], { io, serviceDependencies: { service: { doctor: async () => ({ profile: 'valid', state: 'needs_attention' }) } } }), 1);
});
