import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { planEscape, safeFootprint, safeSegment, executeEscape } from '../src/escape.js';
import { ControlArbiter } from '../src/control.js';
import { SurvivalController } from '../src/survival.js';

function vector(x, y, z) {
  return { x, y, z, offset(dx, dy, dz) { return vector(x + dx, y + dy, z + dz); }, distanceTo(p) { return Math.hypot(x - p.x, y - p.y, z - p.z); } };
}
const solid = { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
const air = { name: 'air', boundingBox: 'empty', shapes: [] };
const flat = p => p.y < 64 ? solid : air;
const origin = vector(0.5, 64, 0.5);
const threats = [{ id: 1, name: 'creeper', position: vector(-2, 64, 0.5) }];
const base = { position: origin, onGround: true, blockAt: flat, threats };
function body() {
  const calls = [];
  return { calls, entity: { position: origin, onGround: true }, blockAt: flat, look: async () => calls.push('look'), setControlState: () => calls.push('forward') };
}
test('flat terrain selects a step away from close threat', () => {
  const plan = planEscape(base);
  assert.equal(plan.state, 'PLANNED');
  assert.equal(plan.destination.x, 1.5);
});
test('unknown world, airborne start and absent threat never generate motion', () => {
  assert.equal(planEscape({ ...base, blockAt: () => null }).state, 'BLOCKED');
  assert.equal(planEscape({ ...base, onGround: false }).state, 'BLOCKED');
  assert.equal(planEscape({ ...base, threats: [] }).state, 'BLOCKED');
});
test('footprint rejects cliff, lava, partial support, ceiling and slippery ground', () => {
  const cases = [
    p => p.y === 63 ? air : flat(p),
    p => p.y === 64 ? { name: 'lava' } : flat(p),
    p => p.y === 63 ? { ...solid, shapes: [[0, 0, 0, 1, 0.5, 1]] } : flat(p),
    p => p.y === 65 ? solid : flat(p),
    p => p.y === 63 ? { ...solid, name: 'ice' } : flat(p)
  ];
  for (const blockAt of cases) assert.equal(safeFootprint(blockAt, origin), false);
});
test('player edge extending over missing support is rejected', () => {
  const edge = vector(0.9, 64, 0.5);
  assert.equal(safeFootprint(p => p.x === 1 && p.y === 63 ? air : flat(p), edge), false);
});
test('blocked direct route halts when alternatives offer insufficient separation', () => {
  const blockAt = p => p.x === 1 && p.y === 64 ? solid : flat(p);
  const plan = planEscape({ ...base, blockAt });
  assert.equal(plan.state, 'BLOCKED'); // Sideways gain is too small; no blind fallback.
});
test('opposing threats prevent retreat directly toward another enemy', () => {
  const plan = planEscape({ ...base, threats: [...threats, { position: vector(3, 64, 0.5) }] });
  assert.equal(plan.state, 'BLOCKED');
});
test('segment validation rejects long jumps, vertical changes and intermediate obstacle', () => {
  assert.equal(safeSegment(flat, origin, vector(4, 64, 0.5)), false);
  assert.equal(safeSegment(flat, origin, vector(1.5, 65, 0.5)), false);
  assert.equal(safeSegment(p => p.x === 1 && p.y === 64 ? solid : flat(p), origin, vector(1.5, 64, 0.5)), false);
});
test('execution revalidates geometry after async look', async () => {
  const bot = body(); let finish;
  bot.look = () => new Promise(resolve => { finish = resolve; });
  const arbiter = new ControlArbiter(() => bot.calls.push('stop'));
  const action = arbiter.run('escape', 1000, session => executeEscape(bot, vector(1.5, 64, 0.5), session));
  await settle(); bot.blockAt = () => null; finish();
  assert.equal((await action).state, 'FAILED');
  assert.equal(bot.calls.includes('forward'), false);
  assert.equal(bot.calls.at(-1), 'stop');
});
test('cancel during aim prevents movement after delayed look', async () => {
  const bot = body(); let finish;
  bot.look = () => new Promise(resolve => { finish = resolve; });
  const arbiter = new ControlArbiter(() => bot.calls.push('stop'));
  const action = arbiter.run('escape', 1000, session => executeEscape(bot, vector(1.5, 64, 0.5), session));
  await settle(); arbiter.cancel('death'); finish();
  assert.equal((await action).state, 'CANCELLED'); await settle();
  assert.equal(bot.calls.includes('forward'), false);
});
test('simulated motion completes and cleans up', async () => {
  const bot = body(); let clock = 0;
  const arbiter = new ControlArbiter(() => bot.calls.push('stop'));
  const action = await arbiter.run('escape', 1000, session => executeEscape(bot, vector(1.5, 64, 0.5), session, {
    now: () => clock,
    wait: async () => { clock += 50; bot.entity.position = bot.entity.position.offset(0.25, 0, 0); }
  }));
  assert.equal(action.state, 'COMPLETED');
  assert.equal(bot.calls.filter(c => c === 'forward').length, 4);
  assert.equal(bot.calls.at(-1), 'stop');
});
test('no progress times out rather than moving indefinitely', async () => {
  const bot = body(); let clock = 0;
  const arbiter = new ControlArbiter(() => bot.calls.push('stop'));
  const result = await arbiter.run('escape', 1000, session => executeEscape(bot, vector(1.5, 64, 0.5), session, {
    now: () => clock, wait: async () => { clock += 50; }
  }));
  assert.equal(result.state, 'FAILED');
  assert.equal(bot.calls.at(-1), 'stop');
});
test('survival integration preempts work on close creeper and cancels when threat leaves', async () => {
  const bot = body();
  Object.assign(bot, { health: 20, food: 20, inventory: { items: () => [] }, entities: { 1: threats[0] } });
  const arbiter = new ControlArbiter(() => bot.calls.push('stop'));
  const survival = new SurvivalController(bot, arbiter, () => {});
  survival.start();
  const strategy = arbiter.run('strategy', 100, () => new Promise(() => {}));
  survival.tick(); await settle();
  assert.equal((await strategy).state, 'CANCELLED');
  assert.equal(arbiter.current.owner, 'survival-escape');
  bot.entities = {}; survival.tick(); await settle();
  assert.equal(arbiter.current, null);
  survival.stop();
});
