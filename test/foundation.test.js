import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ControlArbiter } from '../src/control.js';
import { parseConfig } from '../src/config.js';
import { attachRuntime } from '../src/runtime.js';
const env = { MC_HOST: 'example.org', MC_AUTH: 'offline' };
test('configuration requires explicit authentication and valid port', () => {
  assert.equal(parseConfig(env, 'alice').port, 25565);
  assert.throws(() => parseConfig({ MC_HOST: 'x' }, 'alice'));
  assert.throws(() => parseConfig({ ...env, MC_PORT: '-1' }, 'alice'));
  assert.throws(() => parseConfig(env, '../secret'));
  assert.throws(() => parseConfig({ ...env, MC_AUTH: 'microsoft' }, 'alice'));
});
test('completion releases controls', async () => {
  let stops = 0;
  const arbiter = new ControlArbiter(() => stops++);
  assert.equal((await arbiter.run('test', 10, async ({ guard }) => guard(() => {}))).state, 'COMPLETED');
  assert.equal(stops, 1);
  assert.equal(arbiter.current, null);
});
test('preemption revokes old callbacks and lower priorities are blocked', async () => {
  const arbiter = new ControlArbiter(() => {});
  let oldGuard;
  const first = arbiter.run('strategy', 100, async ({ guard }) => { oldGuard = guard; await new Promise(() => {}); });
  await Promise.resolve();
  assert.equal((await arbiter.run('background', 10, async () => {})).state, 'BLOCKED');
  assert.equal((await arbiter.run('reflex', 900, async () => {})).state, 'COMPLETED');
  assert.equal((await first).state, 'CANCELLED');
  assert.throws(() => oldGuard(() => assert.fail('stale command executed')));
});
test('uncooperative tasks time out and release ownership', async () => {
  const arbiter = new ControlArbiter(() => {});
  const result = await arbiter.run('hung', 10, () => new Promise(() => {}), 10);
  assert.equal(result.state, 'CANCELLED');
  assert.equal(result.reason, 'timeout');
  assert.equal(arbiter.current, null);
});
test('failed action cleans up', async () => {
  let stops = 0;
  const arbiter = new ControlArbiter(() => stops++);
  assert.equal((await arbiter.run('failure', 1, () => { throw new Error('test'); })).state, 'FAILED');
  assert.equal(stops, 1);
});
test('death invalidates movement; respawn does not resume intent', async () => {
  const bot = new EventEmitter();
  const controls = [];
  Object.assign(bot, { health: 20, food: 20, clearControlStates: () => controls.push('clear'), stopDigging() {}, deactivateItem() {}, quit() {}, setControlState: (...args) => controls.push(args) });
  const runtime = attachRuntime(bot, () => {});
  assert.equal((await runtime.step()).state, 'BLOCKED');
  bot.emit('spawn');
  const action = runtime.step();
  await Promise.resolve();
  bot.emit('death');
  assert.equal((await action).state, 'CANCELLED');
  assert.equal(runtime.status().ready, false);
  bot.emit('spawn');
  assert.equal(runtime.arbiter.current, null);
  assert.equal(controls.filter(x => Array.isArray(x)).length, 1);
  bot.emit('end');
  assert.equal(runtime.status().ready, false);
});
