import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { ControlArbiter } from '../src/control.js';
import { autonomousWorldPolicy } from '../src/permissions.js';
import { parseConfig } from '../src/config.js';
import { createToolRegistry } from '../shared/tools/index.js';
import { validateGoal, catalog } from '../src/strategy/goals.js';
import { cropAges, scanCrops, checkHarvest, harvestCrop } from '../shared/tools/farm.js';
import { vec } from '../test-support/craft-fixture.js';
import { observe } from '../src/runtime.js';
import { AttemptLedger } from '../src/strategy/attempts.js';
const point = { x: 2, y: 64, z: 0 };
const args = { ...point, expectedCrop: 'carrots' };
const policy = autonomousWorldPolicy();
function latch() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const cells = new Map(), calls = [], client = new EventEmitter(); client.state = 'play';
  function make(name, x, y, z, age) { return { name, position: vec(x, y, z), stateId: name === 'air' ? 0 : name === 'farmland' ? 2 : 1, diggable: true, boundingBox: name === 'air' ? 'empty' : 'block', shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({ age }), canHarvest: hand => hand === null }; }
  const put = (name, x = 2, y = 64, z = 0, age = cropAges[name]) => { const block = make(name, x, y, z, age); cells.set(`${x},${y},${z}`, block); return block; };
  put('carrots'); put('farmland', 2, 63, 0);
  const slots = Array(46).fill(null);
  const bot = {
    version: '1.21.1', _client: client, entity: { position: vec(0.5, 64, 0.5), onGround: true }, entities: {}, game: { dimension: 'overworld' },
    health: 20, food: 20, oxygenLevel: 20, inventory: { slots, selectedItem: null, items: () => slots.filter(Boolean) }, currentWindow: null, heldItem: null,
    blockAt: p => cells.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || make(Math.floor(p.y) < 64 ? 'stone' : 'air', Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    registry: { blocksByStateId: { 0: { name: 'air' }, 1: { name: 'carrots' }, 2: { name: 'farmland' } } },
    lookAt: async () => { calls.push('look'); }, canDigBlock: () => true, digTime: () => 0,
    setQuickBarSlot: index => { calls.push(['slot', index]); bot.heldItem = slots[36 + index]; },
    stopDigging: () => { calls.push('stop'); }
  };
  bot.dig = async (block, forceLook) => { calls.push(['dig', forceLook]); put('air', block.position.x, block.position.y, block.position.z); client.emit('block_change', { location: block.position, type: 0 }); };
  const arbiter = new ControlArbiter(bot.stopDigging);
  const run = (options = {}, goal = args, permission = policy) => arbiter.run('strategy', 100, session => harvestCrop(bot, goal, permission, session, options), 6000);
  return { bot, client, slots, calls, put, arbiter, run };
}
const digs = f => f.calls.filter(call => Array.isArray(call) && call[0] === 'dig').length;
test('farming schemas forbid arbitrary block types, out-of-range coordinates and extra actions', () => {
  assert.equal(validateGoal({ tool: 'harvest_crop', args, reason: '' }).tool, 'harvest_crop');
  for (const value of [{ ...args, expectedCrop: 'chest' }, { ...args, y: 320 }, { ...args, x: 0.1 }, { ...args, replant: true }]) assert.throws(() => validateGoal({ tool: 'harvest_crop', args: value, reason: '' }));
  assert.equal(catalog.some(tool => tool.name === 'harvest_crop'), false);
});
test('farming is automatic in autonomous-world mode and separately optional in restricted mode', () => {
  const base = { MC_HOST: 'example.org', MC_AUTH: 'offline' };
  assert.equal(parseConfig(base, 'alice').farmingPolicy.enabled, false);
  assert.throws(() => parseConfig({ ...base, MC_FARMING_ENABLED: 'true' }, 'alice'));
  const world = parseConfig({ ...base, MC_WORLD_ID: 'world-a', MC_OPERATING_MODE: 'autonomous_world', MC_FARMING_ENABLED: 'false' }, 'alice');
  assert.equal(world.farmingPolicy.scope, 'world'); assert.equal(world.restrictedSettingsIgnored, true);
  assert.ok(createToolRegistry(world).catalog().some(tool => tool.name === 'harvest_crop'));
  assert.equal(createToolRegistry().catalog().some(tool => tool.name === 'harvest_crop'), false);
  assert.ok(createToolRegistry().catalog().some(tool => tool.name === 'scan_crops'));
});
test('read-only discovery reports mature and immature crops without modifying the world', () => {
  const f = fixture(); f.put('wheat', 1, 64, 1, 2); const result = scanCrops(f.bot, policy);
  assert.ok(result.crops.some(crop => crop.crop === 'carrots' && crop.mature && crop.eligible));
  assert.ok(result.crops.some(crop => crop.crop === 'wheat' && !crop.mature && !crop.eligible));
  assert.equal(f.calls.length, 0);
});
test('crop discovery is bounded, ignores unknown maturity, and respects occlusion', () => {
  const f = fixture();
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) if (x !== 0 || z !== 0) f.put('carrots', x, 64, z);
  assert.ok(scanCrops(f.bot, policy).crops.length <= 16);
  const g = fixture(); g.put('carrots', 2, 64, 0, undefined).getProperties = () => ({});
  assert.equal(scanCrops(g.bot, policy).crops.length, 0);
  const h = fixture(); h.put('stone', 1, 64, 0); h.put('stone', 1, 65, 0);
  assert.equal(scanCrops(h.bot, policy).crops.length, 0);
});
test('all four supported crops require their exact mature age and leave immature plants intact', async () => {
  for (const [crop, age] of Object.entries(cropAges)) {
    const f = fixture(); f.put(crop, 2, 64, 0, age - 1);
    assert.equal((await f.run({}, { ...args, expectedCrop: crop })).state, 'FAILED'); assert.equal(digs(f), 0);
    f.put(crop, 2, 64, 0, String(age));
    assert.equal((await f.run({}, { ...args, expectedCrop: crop })).state, 'COMPLETED'); assert.equal(digs(f), 1);
  }
});
test('invalid maturity encodings do not coerce into ripe crops', () => {
  for (const age of [null, true, ' 7', '7.0', '07', 7.1, 8, -1, {}, NaN]) {
    const f = fixture(); f.put('carrots', 2, 64, 0, age); assert.equal(scanCrops(f.bot, policy).crops.length, 0);
  }
});
test('harvest reports server-observed removal without claiming yield, pickup or replanting', async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.state, 'COMPLETED'); assert.equal(result.result.serverObservedAir, true);
  assert.equal(result.result.dropsCollected, 'not_verified'); assert.equal(result.result.replanted, false);
  assert.equal(result.result.exclusiveCausalityClaimed, false); assert.equal(f.bot.blockAt(vec(2, 63, 0)).name, 'farmland');
  assert.equal(f.client.listenerCount('block_change'), 0); assert.deepEqual(f.calls.find(Array.isArray), ['dig', 'ignore']);
});
test('empty-hand staging selects an empty hotbar slot without equipment transfers or tossing', async () => {
  const f = fixture(); f.slots[36] = { name: 'diamond_sword', count: 1 }; f.bot.heldItem = f.slots[36];
  assert.equal((await f.run()).state, 'COMPLETED'); assert.deepEqual(f.calls.find(Array.isArray), ['slot', 1]);
  const g = fixture(); for (let i = 36; i < 45; i++) g.slots[i] = { name: 'stone', count: 64 }; g.bot.heldItem = g.slots[36];
  assert.equal((await g.run()).state, 'FAILED'); assert.equal(digs(g), 0);
  assert.equal(scanCrops(g.bot, policy).crops[0].reason, 'harvest_empty_hand_unavailable');
});
test('safe motionless food gathering is allowed when hungry, but not with unknown vitals', async () => {
  const f = fixture(); f.bot.food = 0; assert.equal((await f.run()).state, 'COMPLETED');
  const g = fixture(); g.bot.food = undefined; assert.equal((await g.run()).state, 'FAILED'); assert.equal(digs(g), 0);
});
test('injury, nearby danger, airborne footing and busy inventory prevent harvesting', async () => {
  for (const change of [f => { f.bot.health = 5; }, f => { f.bot.entities[2] = { name: 'zombie', position: vec(1, 64, 1) }; }, f => { f.bot.entity.onGround = false; }, f => { f.bot.currentWindow = { id: 1 }; }, f => { f.bot.inventory.selectedItem = {}; }]) {
    const f = fixture(); change(f); assert.equal((await f.run()).state, 'FAILED'); assert.equal(digs(f), 0);
  }
});
test('wrong crop, wrong soil, out-of-reach and disabled permission fail before digging', async () => {
  const f = fixture(); f.put('potatoes'); assert.equal((await f.run()).state, 'FAILED');
  const g = fixture(); g.put('dirt', 2, 63, 0); assert.equal((await g.run()).state, 'FAILED');
  const h = fixture(); h.bot.entity.position = vec(8.5, 64, 0.5); assert.equal((await h.run()).state, 'FAILED');
  const i = fixture(); assert.equal((await i.run({}, args, { enabled: false })).state, 'FAILED');
  for (const sample of [f, g, h, i]) assert.equal(digs(sample), 0);
});
test('restricted farming bounds do not inherit mining or collection authorization', async () => {
  const f = fixture();
  const area = { enabled: true, dimension: 'overworld', area: { minX: 0, minY: 64, minZ: 0, maxX: 1, maxY: 64, maxZ: 1 } };
  assert.equal((await f.run({}, args, area)).state, 'FAILED'); assert.equal(digs(f), 0);
  assert.equal(createToolRegistry({ miningPolicy: policy, collectionPolicy: policy }).catalog().some(tool => tool.name === 'harvest_crop'), false);
});
test('changed crop maturity, farmland or held item during aim prevents stale harvesting', async () => {
  for (const change of [f => { f.put('carrots', 2, 64, 0, 0); }, f => { f.put('dirt', 2, 63, 0); }, f => { f.bot.heldItem = { name: 'stick' }; }]) {
    const f = fixture(); f.bot.lookAt = async () => change(f);
    assert.equal((await f.run()).state, 'FAILED'); assert.equal(digs(f), 0);
  }
});
test('body replacement and world changes invalidate the action even with world permission', async () => {
  for (const change of [f => { f.bot.entity = { ...f.bot.entity }; }, f => { f.bot.game.dimension = 'the_nether'; }]) {
    const f = fixture(); f.bot.lookAt = async () => change(f);
    assert.equal((await f.run()).state, 'FAILED'); assert.equal(digs(f), 0);
  }
});
test('preemption during aim prevents any late digging', async () => {
  const f = fixture(), entered = latch(), finish = latch();
  f.bot.lookAt = async () => { entered.resolve(); await finish.promise; };
  const pending = f.run(); await entered.promise; await f.arbiter.run('reflex', 1000, async () => {});
  assert.equal((await pending).state, 'CANCELLED'); finish.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(digs(f), 0); assert.equal(f.client.listenerCount('block_change'), 0);
});
test('cancellation while digging removes the acknowledgement listener immediately', async () => {
  const f = fixture(), entered = latch(), finish = latch();
  f.bot.dig = async () => { entered.resolve(); await finish.promise; };
  const pending = f.run(); await entered.promise; f.arbiter.cancel('death');
  assert.equal(f.client.listenerCount('block_change'), 0); assert.equal((await pending).state, 'CANCELLED');
  finish.resolve(); f.client.emit('block_change', { location: point, type: 0 });
});
test('optimistic air without an inbound removal packet cannot confirm harvesting', async () => {
  const f = fixture(); f.bot.dig = async () => { f.put('air'); };
  assert.equal((await f.run({ confirmationMs: 20 })).state, 'FAILED'); assert.equal(f.client.listenerCount('block_change'), 0);
});
test('unrelated removal packets and changed non-air target states are not success', async () => {
  for (const packet of [{ location: { x: 3, y: 64, z: 0 }, type: 0 }, { location: point, type: 2 }]) {
    const f = fixture(); f.bot.dig = async () => { f.client.emit('block_change', packet); };
    assert.equal((await f.run({ confirmationMs: 20 })).state, 'FAILED'); assert.equal(f.client.listenerCount('block_change'), 0);
  }
});
test('dig rejection is handled even if a matching removal packet was already received', async () => {
  const f = fixture(); f.bot.dig = async () => { f.client.emit('block_change', { location: point, type: 0 }); throw new Error('rejected'); };
  assert.equal((await f.run()).state, 'FAILED'); assert.equal(f.client.listenerCount('block_change'), 0);
});
test('late aim and a stalled dig remain bounded', async () => {
  const f = fixture(); f.bot.lookAt = () => new Promise(() => {});
  assert.equal((await f.run({ aimMs: 20 })).state, 'FAILED'); assert.equal(digs(f), 0);
  const g = fixture(); g.bot.dig = () => new Promise(() => {});
  assert.equal((await g.run({ confirmationMs: 20 })).state, 'FAILED'); assert.equal(g.client.listenerCount('block_change'), 0);
});
test('danger during an in-flight dig aborts before the ordinary confirmation deadline', async () => {
  const f = fixture(); f.bot.dig = async () => { f.bot.entities[2] = { name: 'creeper', position: vec(1, 64, 1) }; };
  const result = await createToolRegistry({ farmingPolicy: policy }).execute(f.bot, f.arbiter, { tool: 'harvest_crop', args, reason: '' }, {});
  assert.equal(result.state, 'FAILED'); assert.equal(result.reason, 'harvest_unsafe_body'); assert.equal(f.client.listenerCount('block_change'), 0);
});
test('registry emits structured farming diagnostics and read-only scanning remains always available', async () => {
  const f = fixture(), registry = createToolRegistry({ farmingPolicy: policy }), events = [];
  const result = await registry.execute(f.bot, f.arbiter, { tool: 'harvest_crop', args, reason: '' }, { emit: event => events.push(event) });
  assert.equal(result.state, 'COMPLETED'); assert.equal(events[0].type, 'FARMING-RESULT');
});
test('real pinned Minecraft 1.21.1 crop states decode string ages correctly', () => {
  const require = createRequire(import.meta.resolve('mineflayer'));
  const registry = require('prismarine-registry')('1.21.1'), Block = require('prismarine-block')(registry);
  for (const [name, age] of Object.entries(cropAges)) {
    const f = fixture(), definition = registry.blocksByName[name];
    const ripe = Block.fromStateId(definition.maxStateId, 0); ripe.position = vec(2, 64, 0);
    const read = f.bot.blockAt; f.bot.blockAt = p => Math.floor(p.x) === 2 && Math.floor(p.y) === 64 && Math.floor(p.z) === 0 ? ripe : read(p);
    assert.equal(ripe.getProperties().age, String(age));
    assert.doesNotThrow(() => checkHarvest(f.bot, { ...args, expectedCrop: name }, policy));
    const immature = Block.fromStateId(definition.minStateId, 0); immature.position = ripe.position;
    f.bot.blockAt = p => Math.floor(p.x) === 2 && Math.floor(p.y) === 64 && Math.floor(p.z) === 0 ? immature : read(p);
    assert.throws(() => checkHarvest(f.bot, { ...args, expectedCrop: name }, policy), /harvest_not_mature/);
  }
});

test('runtime observes farm maturity and read-only crop scans are never placed on a cooldown', () => {
  const f = fixture();
  assert.equal(observe(f.bot, { farmingPolicy: policy }).farming.crops[0].mature, true);
  const ledger = new AttemptLedger({ now: () => 0 }), goal = { tool: 'scan_crops', args: {}, reason: '' };
  const observation = { dimension: 'overworld', position: { x: 0.5, y: 64, z: 0.5 } };
  ledger.record(goal, observation, 'FAILED'); assert.equal(ledger.remaining(goal, observation), 0);
});
