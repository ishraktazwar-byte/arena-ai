import { autonomousWorldPolicy } from '../src/permissions.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { navigateLocal, planLocalRoute } from '../shared/tools/navigate.js';
import { createToolRegistry } from '../shared/tools/index.js';
import { validateGoal, catalog } from '../src/strategy/goals.js';
import { ControlArbiter } from '../src/control.js';
import { parseConfig } from '../src/config.js';
import { vec } from '../test-support/craft-fixture.js';
const policy = { enabled: true, dimension: 'overworld', area: { minX: -6, minY: 64, minZ: -6, maxX: 6, maxY: 64, maxZ: 6 } };
function latch() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  let clock = 0, yaw = 0, forward = false;
  const calls = [], terrain = new Map();
  const bot = {
    version: '1.21.1', _client: { state: 'play' }, game: { dimension: 'overworld' }, entity: { position: vec(0.5, 64, 0.5), onGround: true },
    entities: {}, health: 20, food: 20, oxygenLevel: 20, inventory: { slots: Array(46).fill(null), items: () => [], selectedItem: null },
    blockAt: p => terrain.has(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ? terrain.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) : Math.floor(p.y) < 64 ? { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : { name: 'air' },
    look: async y => { yaw = y; calls.push(['look']); },
    setControlState: (key, value) => { if (key === 'forward') forward = value; calls.push([key, value]); },
    clearControlStates: () => { forward = false; calls.push(['stop']); }
  };
  const f = { bot, calls, onTick: null, frozen: false, at: time => { clock = time; }, get forward() { return forward; }, setBlock: (x, y, z, value) => terrain.set(`${x},${y},${z}`, value) };
  const arbiter = new ControlArbiter(bot.clearControlStates);
  const wait = async (ms, signal) => {
    if (signal.aborted) throw new Error('cancelled');
    clock += ms;
    if (forward && !f.frozen) bot.entity.position = bot.entity.position.offset(-Math.sin(yaw) * 0.2, 0, -Math.cos(yaw) * 0.2);
    f.onTick?.();
  };
  f.arbiter = arbiter;
  f.run = (args = { x: 3, z: 0 }, options = {}, permission = policy) => arbiter.run('strategy', 100, session => navigateLocal(bot, args, permission, session, { now: () => clock, wait, ...options }), 15000);
  f.anchor = () => ({ entity: bot.entity, dimension: bot.game.dimension, position: { ...bot.entity.position } });
  return f;
}
const forwards = f => f.calls.filter(([key, value]) => key === 'forward' && value).length;

test('navigation schema accepts only bounded integer x,z, never permissions or a generated path', () => {
  assert.equal(validateGoal({ tool: 'navigate_local', args: { x: 3, z: 0 }, reason: '' }).tool, 'navigate_local');
  for (const args of [{ x: 1.5, z: 0 }, { x: 30000001, z: 0 }, { x: 1, y: 64, z: 0 }, { x: 1, z: 0, path: [] }]) assert.throws(() => validateGoal({ tool: 'navigate_local', args, reason: '' }));
  assert.equal(catalog.some(tool => tool.name === 'navigate_local'), false);
});
test('navigation permission is independent and its registry constraints are copied', () => {
  const env = { MC_HOST: 'example.org', MC_AUTH: 'offline' };
  assert.equal(parseConfig(env, 'alice').navigationPolicy.enabled, false);
  assert.throws(() => parseConfig({ ...env, MC_NAVIGATION_ENABLED: 'true' }, 'alice'));
  const config = parseConfig({ ...env, MC_NAVIGATION_ENABLED: 'true', MC_NAVIGATION_AREA: '-6,64,-6,6,64,6' }, 'alice');
  assert.equal(config.navigationPolicy.enabled, true); assert.equal(config.miningPolicy.enabled, false); assert.equal(config.collectionPolicy.enabled, false);
  assert.equal(createToolRegistry().catalog().some(tool => tool.name === 'navigate_local'), false);
  const p = structuredClone(policy), registry = createToolRegistry({ navigationPolicy: p }); p.area.maxX = 0;
  assert.equal(registry.catalog().find(tool => tool.name === 'navigate_local').constraints.area.maxX, 6);
});
test('straight local navigation uses the bounded ground mover and reports only local arrival', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.state, 'COMPLETED'); assert.ok(result.result.legs > 0); assert.ok(forwards(f) > 0);
  assert.equal(result.result.arrival, 'local_position_estimate'); assert.equal(result.result.serverPositionVerified, false);
  assert.equal(result.result.resourceAvailabilityVerified, false); assert.equal(f.forward, false);
  assert.ok(Math.hypot(f.bot.entity.position.x - 3.5, f.bot.entity.position.z - 0.5) <= 0.25);
});
test('already at destination succeeds without issuing forward movement', async () => {
  const f = fixture(), result = await f.run({ x: 0, z: 0 });
  assert.equal(result.state, 'COMPLETED'); assert.equal(result.result.legs, 0); assert.equal(forwards(f), 0);
});
test('local search routes around a solid obstacle instead of digging or crossing it', async () => {
  const f = fixture(); f.setBlock(1, 64, 0, { name: 'stone' });
  const route = planLocalRoute(f.bot, { x: 3.5, y: 64, z: 0.5 }, policy, f.anchor());
  assert.ok(route.some(p => p.z !== 0.5)); assert.equal(route.some(p => Math.floor(p.x) === 1 && Math.floor(p.z) === 0), false);
  const result = await f.run(); assert.equal(result.state, 'COMPLETED'); assert.equal(f.forward, false);
  assert.equal(f.calls.some(([key]) => ['jump', 'dig', 'sprint'].includes(key)), false);
});
test('enclosed or occupied destinations fail without moving', async () => {
  for (const blocked of [[3, 64, 0], [2, 64, 0]]) {
    const f = fixture();
    if (blocked[0] === 3) f.setBlock(...blocked, { name: 'stone' });
    else for (const [x, z] of [[2, 0], [4, 0], [3, 1], [3, -1]]) f.setBlock(x, 64, z, { name: 'stone' });
    assert.equal((await f.run()).state, 'FAILED'); assert.equal(forwards(f), 0);
  }
});
test('unknown terrain, unsupported destination, and unsafe surfaces are not traversed', async () => {
  for (const support of [null, { name: 'air' }, { name: 'sand', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }]) {
    const f = fixture(); f.setBlock(3, 63, 0, support);
    assert.equal((await f.run()).state, 'FAILED'); assert.equal(forwards(f), 0);
  }
});
test('headroom is checked along the route and at the destination', async () => {
  const f = fixture(); f.setBlock(3, 65, 0, { name: 'stone' });
  assert.equal((await f.run()).state, 'FAILED'); assert.equal(forwards(f), 0);
});
test('the approved boundary cannot be bypassed by detouring around a wall', async () => {
  const f = fixture(); f.setBlock(1, 64, 0, { name: 'stone' });
  const narrow = { ...policy, area: { ...policy.area, minZ: 0, maxZ: 0 } };
  assert.equal((await f.run({ x: 3, z: 0 }, {}, narrow)).state, 'FAILED'); assert.equal(forwards(f), 0);
});
test('player footprint, destination radius and permission are checked before movement', async () => {
  const f = fixture(); assert.equal((await f.run({ x: 7, z: 0 })).state, 'FAILED'); assert.equal(forwards(f), 0);
  const g = fixture(); g.bot.entity.position = vec(0.1, 64, 0.5);
  assert.equal((await g.run({ x: 3, z: 0 }, {}, { ...policy, area: { ...policy.area, minX: 0 } })).state, 'FAILED');
  const h = fixture(); assert.equal((await h.run({ x: 3, z: 0 }, {}, { enabled: false })).state, 'FAILED');
});
test('airborne, fractional-floor, hungry, injured and inventory-busy bodies refuse navigation', async () => {
  for (const change of [f => { f.bot.entity.onGround = false; }, f => { f.bot.entity.position = vec(0.5, 64.5, 0.5); }, f => { f.bot.food = 5; }, f => { f.bot.health = 8; }, f => { f.bot.currentWindow = { id: 1 }; }, f => { f.bot.inventory.selectedItem = {}; }, f => { delete f.bot.inventory; }]) {
    const f = fixture(); change(f); assert.equal((await f.run()).state, 'FAILED'); assert.equal(forwards(f), 0);
  }
});
test('nearby danger precludes navigation even when a path is geometrically clear', async () => {
  const f = fixture(); f.bot.entities[2] = { name: 'zombie', position: vec(2, 64, 2) };
  assert.equal((await f.run()).state, 'FAILED'); assert.equal(forwards(f), 0);
});
test('danger appearing during movement stops the body', async () => {
  const f = fixture(); f.onTick = () => { f.bot.entities[2] = { name: 'creeper', position: vec(1, 64, 1) }; };
  assert.equal((await f.run()).state, 'FAILED'); assert.equal(f.forward, false);
});
test('changed near terrain invalidates the active step before another movement command', async () => {
  const f = fixture(); f.onTick = () => { f.setBlock(1, 64, 0, { name: 'stone' }); };
  assert.equal((await f.run()).state, 'FAILED'); assert.equal(forwards(f), 1); assert.equal(f.forward, false);
});
test('new distant obstacles are handled by fresh routing between legs', async () => {
  const f = fixture(); let changed = false;
  f.onTick = () => { if (!changed) { f.setBlock(2, 64, 0, { name: 'stone' }); changed = true; } };
  const result = await f.run(); assert.equal(result.state, 'COMPLETED'); assert.equal(f.forward, false);
});
test('body replacement, elevation changes and dimension changes invalidate active routes', async () => {
  for (const update of [f => { f.bot.entity = { ...f.bot.entity }; }, f => { f.bot.entity.position = f.bot.entity.position.offset(0, 1, 0); }, f => { f.bot.game.dimension = 'the_nether'; }]) {
    const f = fixture(); f.onTick = () => update(f);
    assert.equal((await f.run()).state, 'FAILED'); assert.equal(f.forward, false);
  }
});
test('preemption during an awaited aim prevents late movement after a new owner runs', async () => {
  const f = fixture(), began = latch(), finish = latch();
  f.bot.look = async () => { began.resolve(); await finish.promise; };
  const pending = f.run(); await began.promise; await f.arbiter.run('reflex', 1000, async () => {});
  assert.equal((await pending).state, 'CANCELLED'); finish.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(forwards(f), 0); assert.equal(f.forward, false);
});
test('cancellation during active movement releases controls and cannot resume the route', async () => {
  const f = fixture(); f.onTick = () => f.arbiter.cancel('death');
  assert.equal((await f.run()).state, 'CANCELLED'); assert.equal(f.forward, false); assert.equal(forwards(f), 1);
});
test('a frozen body times out rather than walking indefinitely', async () => {
  const f = fixture(); f.frozen = true;
  assert.equal((await f.run()).state, 'FAILED'); assert.equal(f.forward, false); assert.ok(forwards(f) <= 14);
});
test('non-progressing helper is stopped by the twelve-leg budget', async () => {
  const f = fixture(); let legs = 0;
  assert.equal((await f.run({ x: 3, z: 0 }, { move: async () => { legs++; } })).state, 'FAILED'); assert.equal(legs, 12);
});
test('motion deadline applies even when a helper reports late arrival', async () => {
  const f = fixture();
  assert.equal((await f.run({ x: 3, z: 0 }, { move: async () => { f.bot.entity.position = vec(3.5, 64, 0.5); f.at(14000); } })).state, 'FAILED');
});
test('registry exposes sanitized navigation diagnostics without granting other mutation permissions', async () => {
  const f = fixture(), events = [], registry = createToolRegistry({ navigationPolicy: policy });
  f.bot.health = 5;
  const result = await registry.execute(f.bot, f.arbiter, { tool: 'navigate_local', args: { x: 3, z: 0 }, reason: '' }, { emit: event => events.push(event) });
  assert.equal(result.reason, 'navigation_unsafe_body'); assert.equal(events[0].type, 'NAVIGATION-RESULT');
  assert.equal(registry.catalog().some(tool => tool.name === 'mine'), false); assert.equal(registry.catalog().some(tool => tool.name === 'collect_items'), false);
});
test('world-scoped navigation works far outside old test rectangles while preserving per-attempt bounds', async () => {
  const f = fixture(); f.bot.entity.position = vec(1000.5, 64, -999.5);
  assert.equal((await f.run({ x: 1003, z: -1000 }, {}, autonomousWorldPolicy())).state, 'COMPLETED');
  const g = fixture(); assert.equal((await g.run({ x: 7, z: 0 }, {}, autonomousWorldPolicy())).state, 'FAILED');
  assert.equal(forwards(g), 0);
});
