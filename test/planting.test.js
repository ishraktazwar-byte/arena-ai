import { fixture } from '../test-support/farm-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { StrategyController } from '../src/strategy/controller.js';
import { autonomousWorldPolicy } from '../src/permissions.js';
import { plantCrop, sendPlantInteraction } from '../shared/tools/plant.js';
import { cropAges, cropSeeds, scanCrops } from '../shared/tools/farm.js';
import { createToolRegistry } from '../shared/tools/index.js';
import { validateGoal, catalog } from '../src/strategy/goals.js';
import { vec } from '../test-support/craft-fixture.js';
const require = createRequire(import.meta.resolve('mineflayer'));
const data = require('prismarine-registry')('1.21.1');
const point = { x: 2, y: 64, z: 0 }, args = { ...point, crop: 'carrots' }, policy = autonomousWorldPolicy();
function latch() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const writes = f => f.calls.filter(([name]) => name === 'block_place');
test('planting schemas permit only typed supported crop cells and no replacement flag', () => {
  assert.equal(validateGoal({ tool: 'plant_crop', args, reason: '' }).tool, 'plant_crop');
  for (const bad of [{ ...args, crop: 'tnt' }, { ...args, x: 0.2 }, { ...args, y: 320 }, { ...args, replace: true }]) assert.throws(() => validateGoal({ tool: 'plant_crop', args: bad, reason: '' }));
  assert.equal(catalog.some(tool => tool.name === 'plant_crop'), false);
});
test('world mode farming scope exposes planting while default restricted catalog does not', () => {
  assert.equal(createToolRegistry().catalog().some(tool => tool.name === 'plant_crop'), false);
  assert.equal(createToolRegistry({ farmingPolicy: policy }).catalog().find(tool => tool.name === 'plant_crop').constraints.scope, 'world');
});
test('empty farmland discovery reports bounded sites and carried seed options without guaranteeing execution', () => {
  const f = fixture();
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) if (x !== 0 || z !== 0) f.put('farmland', x, 63, z);
  const result = scanCrops(f.bot, policy);
  assert.ok(result.plantingSites.length > 0 && result.plantingSites.length <= 8);
  assert.ok(result.plantingSites[0].seedOptions.includes('carrots')); assert.equal(result.plantingSites[0].executionRecheckRequired, true);
  assert.equal(writes(f).length, 0);
});
test('all four crops use their correct carried planting item and verify a seedling plus consumption', async () => {
  for (const [crop, item] of Object.entries(cropSeeds)) {
    const f = fixture(); f.seed(item);
    const result = await f.run({}, { ...args, crop });
    assert.equal(result.state, 'COMPLETED'); assert.equal(result.result.seed, item);
    assert.equal(result.result.serverObservedSeedling, true); assert.equal(result.result.seedCountBefore - result.result.seedCountAfter, 1);
    assert.equal(result.result.serverInventoryVerified, true); assert.equal(result.result.exclusiveCausalityClaimed, false); assert.equal(result.result.futureGrowthGuaranteed, false);
  }
});
test('one-seed stacks can be fully consumed without requiring a still-held item after planting', async () => {
  const f = fixture(); f.seed('carrot', 1);
  assert.equal((await f.run()).state, 'COMPLETED'); assert.equal(f.bot.heldItem, null);
});
test('seed staging prefers an existing hotbar stack without inventory clicks', async () => {
  const f = fixture(); f.slots[36] = null; f.seed('carrot', 3, 39);
  assert.equal((await f.run()).state, 'COMPLETED'); assert.ok(f.calls.some(([name, index]) => name === 'held' && index === 3));
  assert.equal(f.calls.some(([name]) => name === 'click'), false);
});
test('main-inventory staging uses one guarded number-key swap below slot 36 and authoritative resync', async () => {
  const f = fixture(); f.slots[36] = null; f.seed('carrot', 3, 9);
  assert.equal((await f.run()).state, 'COMPLETED'); assert.deepEqual(f.calls.find(([name]) => name === 'click'), ['click', 9, 0, 2]);
  assert.equal(f.calls.filter(([name]) => name === 'sync').length, 3);
});
test('full hotbar without a seed stack refuses transfer instead of overwriting or tossing', async () => {
  const f = fixture(); for (let i = 36; i < 45; i++) f.seed('stone', 64, i); f.seed('carrot', 3, 9);
  assert.equal((await f.run()).state, 'FAILED'); assert.equal(writes(f).length, 0); assert.equal(f.calls.some(([name]) => name === 'click'), false);
});
test('missing seeds and unconfirmed baseline inventory prevent planting', async () => {
  const f = fixture(); f.slots[36] = null; assert.equal((await f.run()).state, 'FAILED'); assert.equal(writes(f).length, 0);
  const g = fixture(); g.bot._syncWindow = async () => {};
  assert.equal((await g.run()).state, 'FAILED'); assert.equal(writes(g).length, 0);
});
test('an occupied cell is never replaced, even if it contains the requested crop', async () => {
  for (const name of ['carrots', 'stone', 'water']) {
    const f = fixture(); f.put(name);
    assert.equal((await f.run()).state, 'FAILED'); assert.equal(writes(f).length, 0);
  }
});
test('wrong soil, unknown soil, occlusion and distant cells prevent planting', async () => {
  for (const change of [f => { f.put('dirt', 2, 63, 0); }, f => { const read = f.bot.blockAt; f.bot.blockAt = p => Math.floor(p.x) === 2 && Math.floor(p.y) === 63 ? null : read(p); }, f => { f.put('stone', 1, 64, 0); f.put('stone', 1, 65, 0); }, f => { f.bot.entity.position = vec(10.5, 64, 0.5); }]) {
    const f = fixture(); change(f); assert.equal((await f.run()).state, 'FAILED'); assert.equal(writes(f).length, 0);
  }
});
test('farming boundaries still apply in restricted mode', async () => {
  const f = fixture(); const restricted = { enabled: true, dimension: 'overworld', area: { minX: 0, minY: 64, minZ: 0, maxX: 1, maxY: 64, maxZ: 1 } };
  assert.equal((await f.run({}, args, restricted)).state, 'FAILED'); assert.equal(writes(f).length, 0);
});
test('new soil, an occupied target, changed hand or danger during aim blocks the final packet', async () => {
  for (const change of [f => { f.put('dirt', 2, 63, 0); }, f => { f.put('carrots'); }, f => { f.seed('stone'); }, f => { f.bot.entities[2] = { name: 'creeper', position: vec(1, 64, 1) }; }]) {
    const f = fixture(); f.bot.lookAt = async () => change(f);
    assert.equal((await f.run()).state, 'FAILED'); assert.equal(writes(f).length, 0);
  }
});
test('body and dimension changes during seed staging cannot continue into an interaction', async () => {
  for (const change of [f => { f.bot.entity = { ...f.bot.entity }; }, f => { f.bot.game.dimension = 'the_nether'; }]) {
    const f = fixture(); f.slots[36] = null; f.seed('carrot', 3, 9);
    const click = f.bot.clickWindow; f.bot.clickWindow = async (...args) => { await click(...args); change(f); };
    assert.equal((await f.run()).state, 'FAILED'); assert.equal(writes(f).length, 0);
  }
});
test('cancellation during baseline resync immediately removes listeners and prevents later writes', async () => {
  const f = fixture(), entered = latch(), finish = latch();
  f.bot._syncWindow = async () => { entered.resolve(); await finish.promise; f.client.emit('window_items', f.snapshot()); };
  const pending = f.run(); await entered.promise; f.arbiter.cancel('death');
  assert.equal(f.client.listenerCount('window_items'), 0); assert.equal((await pending).state, 'CANCELLED');
  finish.resolve(); await Promise.resolve(); await Promise.resolve(); assert.equal(writes(f).length, 0);
});
test('preemption during aim prevents late planting after another owner runs', async () => {
  const f = fixture(), entered = latch(), finish = latch();
  f.bot.lookAt = async () => { entered.resolve(); await finish.promise; };
  const pending = f.run(); await entered.promise; await f.arbiter.run('reflex', 1000, async () => {});
  assert.equal((await pending).state, 'CANCELLED'); finish.resolve(); await Promise.resolve(); await Promise.resolve(); assert.equal(writes(f).length, 0);
});
test('optimistic crop cache changes without a server packet are not sufficient', async () => {
  const f = fixture(); f.client.write = () => f.plant('carrots', { packet: false });
  assert.equal((await f.run({ responseMs: 20 })).state, 'FAILED'); assert.equal(f.client.listenerCount('block_change'), 0);
});
test('a seedling packet without observed seed consumption cannot confirm planting', async () => {
  const f = fixture(); f.client.write = () => f.plant('carrots', { consume: 0 });
  assert.equal((await f.run()).state, 'FAILED'); assert.equal(f.client.listenerCount('window_items'), 0);
});
test('wrong crop, nonzero age and unrelated location packets cannot establish a seedling', async () => {
  for (const mode of ['wrong', 'grown', 'elsewhere']) {
    const f = fixture(); f.client.write = () => {
      if (mode === 'wrong') f.plant('wheat');
      else if (mode === 'grown') f.plant('carrots', { age: 1 });
      else f.client.emit('block_change', { location: { ...point, x: 3 }, type: data.blocksByName.carrots.minStateId });
    };
    assert.equal((await f.run({ responseMs: 20 })).state, 'FAILED');
  }
});
test('local inventory changes without a final authoritative packet cannot confirm consumption', async () => {
  const f = fixture(); let syncs = 0;
  f.bot._syncWindow = async () => { if (++syncs === 1) f.client.emit('window_items', f.snapshot()); };
  assert.equal((await f.run()).state, 'FAILED'); assert.equal(f.client.listenerCount('window_items'), 0);
});
test('cancellation after interaction removes pending acknowledgement listeners without claiming rollback', async () => {
  const f = fixture(), sent = latch(); f.client.write = () => sent.resolve();
  const pending = f.run(); await sent.promise; f.arbiter.cancel('interrupted');
  assert.equal(f.client.listenerCount('block_change'), 0); assert.equal((await pending).state, 'CANCELLED');
});
test('synchronous interaction failure after a rejected packet does not leave an unhandled rejection', async () => {
  const f = fixture(); f.client.write = () => { f.client.emit('block_change', { location: point, type: data.blocksByName.stone.minStateId }); throw new Error('write failed'); };
  assert.equal((await f.run()).state, 'FAILED'); assert.equal(f.client.listenerCount('block_change'), 0);
});
test('the farmland top-face packet serializes with the pinned Minecraft 1.21.1 protocol', () => {
  const f = fixture(); let packet; f.client.write = (name, params) => { packet = { name, params }; };
  sendPlantInteraction(f.bot, f.bot.blockAt(vec(2, 63, 0)), { guard: fn => fn() });
  assert.equal(packet.params.cursorY, 15 / 16); assert.equal(packet.params.direction, 1); assert.equal(packet.params.hand, 0);
  const protocol = require('minecraft-protocol');
  const serializer = protocol.createSerializer({ state: protocol.states.PLAY, isServer: false, version: '1.21.1' });
  assert.ok(serializer.createPacketBuffer(packet).length > 0);
  const Block = require('prismarine-block')(data);
  for (const crop of Object.keys(cropSeeds)) assert.equal(Block.fromStateId(data.blocksByName[crop].minStateId, 0).getProperties().age, '0');
});
test('a planner-chosen harvest then replant sequence restores a plant using carried reserves', async () => {
  const f = fixture(); f.put('carrots', 2, 64, 0, 7);
  const registry = createToolRegistry({ farmingPolicy: policy }), events = [];
  const strategy = new StrategyController({ toolRegistry: registry, identity: {}, emit: event => events.push(event),
    observe: () => ({ health: 20, food: 20, risk: { mode: 'NORMAL' }, dimension: 'overworld', position: { x: 0.5, y: 64, z: 0.5 } }),
    provider: { plan: async () => ({ reason: '', steps: [{ tool: 'harvest_crop', args: { ...point, expectedCrop: 'carrots' }, reason: '' }, { tool: 'plant_crop', args, reason: '' }] }) },
    execute: goal => registry.execute(f.bot, f.arbiter, goal, {}) });
  strategy.start(); await strategy.tick();
  assert.ok(events.some(event => event.type === 'STRATEGY-PLAN-COMPLETE'));
  assert.equal(f.bot.blockAt(vec(2, 64, 0)).getProperties().age, '0'); assert.equal(f.slots[36].count, 2);
});
test('a locally predicted hotbar swap is refused when authoritative staging inventory disagrees', async () => {
  const f = fixture(); f.slots[36] = null; f.seed('carrot', 3, 9); const before = f.snapshot(); let syncs = 0;
  f.bot._syncWindow = async () => { f.client.emit('window_items', ++syncs === 2 ? before : f.snapshot()); };
  assert.equal((await f.run()).state, 'FAILED'); assert.equal(writes(f).length, 0);
});
test('held-seed evidence must agree with the authoritative selected slot', async () => {
  const f = fixture(), raw = f.snapshot();
  raw.items[9] = raw.items[36]; raw.items[36] = { itemId: data.itemsByName.stone.id, itemCount: 1 };
  f.bot._syncWindow = async () => f.client.emit('window_items', raw);
  assert.equal((await f.run()).state, 'FAILED'); assert.equal(writes(f).length, 0);
});
test('cancellation during a main-slot swap does not perform later hand selection or planting', async () => {
  const f = fixture(), entered = latch(), finish = latch(); f.slots[36] = null; f.seed('carrot', 3, 9);
  const click = f.bot.clickWindow; f.bot.clickWindow = async (...args) => { await click(...args); entered.resolve(); await finish.promise; };
  const pending = f.run(); await entered.promise; f.arbiter.cancel('interrupted');
  assert.equal((await pending).state, 'CANCELLED'); finish.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(writes(f).length, 0); assert.equal(f.calls.some(([name]) => name === 'held'), false);
});
test('transient danger during final inventory resync invalidates the attempt even after a seedling reply', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(), entered = latch(), finish = latch(); let syncs = 0;
  f.bot._syncWindow = async () => { if (++syncs === 2) { entered.resolve(); await finish.promise; } f.client.emit('window_items', f.snapshot()); };
  const pending = f.run(); await entered.promise;
  f.bot.entities[2] = { name: 'creeper', position: vec(1, 64, 1) }; t.mock.timers.tick(50); delete f.bot.entities[2];
  finish.resolve(); assert.equal((await pending).state, 'FAILED'); assert.equal(f.client.listenerCount('block_change'), 0);
});
test('one planner request can harvest, bind a new drop, collect it, then replant without carried reserves', async () => {
  const f = fixture(); f.slots[36] = null; f.bot.entity.id = 1; f.bot.entity.position = vec(1.65, 64, 0.5);
  f.bot.clearControlStates = () => f.calls.push(['stop']); f.put('carrots', 2, 64, 0, 7);
  const dig = f.bot.dig;
  f.bot.dig = async b => {
    await dig(b);
    f.bot.entities[101] = { id: 101, uuid: '12345678-1234-4234-8234-123456789abc', name: 'item', isValid: true,
      position: vec(2.25, 64.1, 0.5), getDroppedItem: () => ({ name: 'carrot', type: data.itemsByName.carrot.id, count: 4 }) };
  };
  let syncs = 0; const sync = f.bot._syncWindow;
  f.bot._syncWindow = async () => {
    await sync();
    if (++syncs === 1) setImmediate(() => {
      f.client.emit('collect', { collectedEntityId: 101, collectorEntityId: 1, pickupItemCount: 4 });
      f.seed('carrot', 4); delete f.bot.entities[101];
    });
  };
  const registry = createToolRegistry({ farmingPolicy: policy, collectionPolicy: policy }), events = [], results = []; let requests = 0;
  const strategy = new StrategyController({ toolRegistry: registry, identity: {}, emit: e => events.push(e),
    observe: () => ({ health: 20, food: 20, risk: { mode: 'NORMAL' }, dimension: 'overworld', position: { x: 1.65, y: 64, z: 0.5 } }),
    provider: { plan: async () => {
      requests++; assert.deepEqual(f.bot.entities, {}); assert.equal(f.bot.heldItem, null);
      return { reason: '', steps: [
        { tool: 'harvest_crop', args: { ...point, expectedCrop: 'carrots' }, reason: '' },
        { tool: 'collect_nearby', args: { expectedItem: 'carrot' }, reason: '' },
        { tool: 'plant_crop', args, reason: '' }
      ] };
    } },
    execute: async goal => { const result = await registry.execute(f.bot, f.arbiter, goal, {}); results.push(result); return result; } });
  strategy.start(); await strategy.tick();
  assert.equal(requests, 1); assert.deepEqual(results.map(r => r.state), ['COMPLETED', 'COMPLETED', 'COMPLETED']);
  assert.equal(results[1].result.inventoryGainObserved, 4); assert.equal(results[1].result.originClaimed, false);
  assert.equal(results[2].result.serverObservedSeedling, true); assert.equal(f.slots[36].count, 3);
  assert.equal(f.bot.blockAt(vec(2, 64, 0)).getProperties().age, '0');
  assert.ok(events.some(e => e.type === 'STRATEGY-PLAN-COMPLETE'));
});
