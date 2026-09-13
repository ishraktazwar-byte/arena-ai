import { EventEmitter } from 'node:events';
import { attachRuntime } from '../src/runtime.js';
import { assessNeeds } from '../src/strategy/needs.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture as baseFixture, data } from '../test-support/farm-fixture.js';
import { fixture as collectionFixture } from '../test-support/collection-fixture.js';
import { vec } from '../test-support/craft-fixture.js';
import { farmFootprint, farmSurface, farmSegment, farmGrounded, executeFarmStep } from '../src/farming/terrain.js';
import { worldReader, safeFootprint } from '../src/escape.js';
import { navigateLocal } from '../shared/tools/navigate.js';
import { FarmManager, chooseFarmAction, farmCells } from '../src/farming/manager.js';
import { validFarm, FARM_CROPS } from '../src/farming/intent.js';
import { attachSeedReserve, foodReserves, mayPlantSeed } from '../src/farming/reservations.js';
import { selectFood, SurvivalController } from '../src/survival.js';
import { MemoryStore } from '../src/memory/store.js';
import { autonomousWorldPolicy } from '../src/permissions.js';
import { createToolRegistry } from '../shared/tools/index.js';
import { validateGoal, catalog } from '../src/strategy/goals.js';
import { StrategyController } from '../src/strategy/controller.js';
function fixture() { const f = baseFixture(); f.bot.entity.position = vec(1.65, 64, 0.5); return f; }
const intent = { x: 2, y: 64, z: 0, crop: 'carrots', targetStock: 6, reserve: 2 };
const policies = () => ({ farming: autonomousWorldPolicy(), collection: autonomousWorldPolicy(), navigation: autonomousWorldPolicy() });
function latch() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function memory(initial = intent) {
  let value = structuredClone(initial); const records = [];
  return { records, retrieveFarm: ({ dimension }) => dimension === 'overworld' ? structuredClone(value) : null,
    remember: async (kind, observation, result) => { records.push({ kind, observation, result }); if (kind === 'farm_intent') value = structuredClone(result.farm); } };
}
function manager(f, options = {}) {
  let clock = 0; const goals = [], store = memory();
  const m = new FarmManager({ bot: f.bot, memory: store, policies: policies(), now: () => clock, execute: async g => { goals.push(g); return { state: 'COMPLETED' }; }, ...options });
  m.start(); return { m, store, goals, advance: (ms = 2000) => { clock += ms; } };
}

test('farmland collision and four crop passability contracts match pinned 1.21.1 blocks', () => {
  const require = createRequire(import.meta.resolve('mineflayer')), Block = require('prismarine-block')(data);
  for (const crop of Object.keys(FARM_CROPS)) {
    const cropBlock = Block.fromStateId(data.blocksByName[crop].defaultState, 0), soil = Block.fromStateId(data.blocksByName.farmland.defaultState, 0);
    const read = p => p.y === 63 ? soil : p.y === 64 ? cropBlock : { name: 'air' };
    assert.equal(farmFootprint(read, vec(0.5, 63.9375, 0.5)), true);
    assert.equal(safeFootprint(read, vec(0.5, 63.9375, 0.5)), false);
  }
});
test('mixed solid-ground and farmland edges allow only a one-sixteenth height step', () => {
  const f = fixture(); f.put('carrots', 2, 64, 0, 0);
  assert.deepEqual(farmSurface(worldReader(f.bot), 2.5, 0.5, 64), { x: 2.5, y: 63.9375, z: 0.5 });
  assert.equal(farmSegment(worldReader(f.bot), vec(1.5, 64, 0.5), vec(2.5, 63.9375, 0.5)), true);
  assert.equal(farmSegment(worldReader(f.bot), vec(1.5, 64, 0.5), vec(2.5, 63, 0.5)), false);
});
test('farmland traversal refuses unsupported shapes, water, hazards, unknown cells and head obstructions', () => {
  for (const name of ['water', 'lava', 'magma_block', 'sand', 'stone_slab']) {
    const f = fixture(); f.put(name, 2, 63, 0);
    assert.equal(farmFootprint(worldReader(f.bot), vec(2.5, 63.9375, 0.5)), false);
  }
  const f = fixture(); f.put('stone', 2, 65, 0); assert.equal(farmFootprint(worldReader(f.bot), vec(2.5, 63.9375, 0.5)), false);
  assert.equal(farmFootprint(() => null, vec(0.5, 64, 0.5)), false);
});
test('grounded farm motion allows tiny settling but rejects jumps and falls', () => {
  const f = fixture(); f.bot.entity.position = vec(2.5, 63.9375, 0.5); f.bot.entity.onGround = false;
  for (const [y, allowed] of [[-0.08, true], [-0.5, false], [0.42, false]]) { f.bot.entity.velocity = { y }; assert.equal(farmGrounded(f.bot), allowed); }
});
test('bounded navigation crosses mature and immature crops without jumping or harvesting', async () => {
  const f = collectionFixture(); let clock = 0;
  f.setBlock(1, 63, 0, { name: 'farmland', boundingBox: 'block', shapes: [[0, 0, 0, 1, 15 / 16, 1]] });
  f.setBlock(1, 64, 0, { name: 'carrots', boundingBox: 'empty', shapes: [] });
  const result = await f.arbiter.run('strategy', 100, s => navigateLocal(f.bot, { x: 2, z: 0 }, autonomousWorldPolicy(), s, { farmTerrain: true, now: () => clock, wait: async (ms, signal) => { clock += ms; await f.wait(ms, signal); const p = f.bot.entity.position; const surface = farmSurface(worldReader(f.bot), p.x, p.z, 64); f.bot.entity.position = vec(p.x, surface.y, p.z); } }));
  assert.equal(result.state, 'COMPLETED'); assert.equal(f.calls.some(([key, value]) => ['jump', 'sprint'].includes(key) && value), false);
  assert.equal(f.forward, false);
});
test('late farm aim cannot start walking after cancellation', async () => {
  const f = collectionFixture(), entered = latch(), done = latch(); f.bot.look = async () => { entered.resolve(); await done.promise; };
  const run = f.arbiter.run('strategy', 100, s => executeFarmStep(f.bot, vec(1, 64, 0.5), s));
  await entered.promise; f.arbiter.cancel('danger'); assert.equal((await run).state, 'CANCELLED'); done.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.calls.some(([key, value]) => key === 'forward' && value), false);
});
test('terrain changing during farm walking cancels further movement', async () => {
  const f = collectionFixture(); let clock = 0;
  const result = await f.arbiter.run('strategy', 100, s => executeFarmStep(f.bot, vec(1.2, 64, 0.5), s, { now: () => clock, wait: async ms => { clock += ms; f.setBlock(1, 63, 0, { name: 'lava' }); } }));
  assert.equal(result.state, 'FAILED'); assert.equal(f.forward, false);
});
test('farm goals have exact bounded schemas and remain permission/persistence gated', () => {
  assert.equal(validFarm(intent), true); assert.equal(validFarm(null), true);
  for (const bad of [{ ...intent, reserve: 0 }, { ...intent, targetStock: 65 }, { ...intent, crop: 'tnt' }, { ...intent, x: 0.5 }, { ...intent, y: -64 }, { ...intent, radius: 100 }]) assert.equal(validFarm(bad), false);
  assert.equal(validateGoal({ tool: 'manage_farm', args: intent, reason: '' }).tool, 'manage_farm');
  assert.throws(() => validateGoal({ tool: 'stop_farm', args: { all: true }, reason: '' }));
  for (const name of ['manage_farm', 'stop_farm', 'navigate_farm']) assert.equal(catalog.some(t => t.name === name), false);
  const opts = { farmingPolicy: policies().farming, collectionPolicy: policies().collection, navigationPolicy: policies().navigation };
  assert.equal(createToolRegistry(opts).catalog().some(t => t.name === 'manage_farm'), false);
  assert.equal(createToolRegistry({ ...opts, farmManagement: true }).catalog().some(t => t.name === 'manage_farm'), true);
  assert.equal(createToolRegistry({ ...opts, collectionPolicy: { enabled: false }, farmManagement: true }).catalog().some(t => t.name === 'manage_farm'), false);
});
test('seed reservation excludes protected carrots from ordinary eating across multiple stacks', () => {
  const items = [{ name: 'carrot', count: 1 }, { name: 'carrot', count: 1 }];
  assert.equal(selectFood(items, { reserves: { carrot: 2 } }), null);
  assert.equal(selectFood([...items, { name: 'apple', count: 1 }], { reserves: { carrot: 2 } }).name, 'apple');
  assert.equal(selectFood([...items, { name: 'carrot', count: 1 }], { reserves: { carrot: 2 } }).name, 'carrot');
  assert.equal(selectFood(items, { reserves: { carrot: 2 }, emergency: true }).name, 'carrot');
});
test('reservation is rechecked after delayed eating equip', async () => {
  const f = fixture(), entered = latch(), done = latch(); f.bot.food = 12; let reserved = 0, consumed = false;
  attachSeedReserve(f.bot, () => ({ seed: 'carrot', count: reserved }));
  f.bot.equip = async () => { entered.resolve(); await done.promise; }; f.bot.consume = async () => { consumed = true; };
  const survival = new SurvivalController(f.bot, f.arbiter, () => {}); survival.start(); survival.tick();
  await entered.promise; reserved = 3; done.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(consumed, false); survival.stop();
});
test('critical hunger can consume protected planting food rather than starve for a farm', async () => {
  const f = fixture(); f.bot.food = 6; let consumed = false;
  attachSeedReserve(f.bot, () => ({ seed: 'carrot', count: 64 })); f.bot.equip = async () => {}; f.bot.consume = async () => { consumed = true; };
  const survival = new SurvivalController(f.bot, f.arbiter, () => {}); survival.start(); survival.tick(); await new Promise(r => setImmediate(r));
  assert.equal(consumed, true); survival.stop();
});
test('planting outside a managed plot cannot spend its last protected item', () => {
  const f = fixture(); attachSeedReserve(f.bot, () => ({ ...intent, seed: 'carrot', count: 3 }));
  assert.equal(mayPlantSeed(f.bot, 'carrot', { x: 20, y: 64, z: 0 }), false);
  assert.equal(mayPlantSeed(f.bot, 'carrot', intent), true);
  f.seed('carrot', 4); assert.equal(mayPlantSeed(f.bot, 'carrot', { x: 20, y: 64, z: 0 }), true);
});
test('a persisted maintenance goal establishes a reserve and stop releases it', async () => {
  const f = fixture(), m = manager(f);
  assert.deepEqual(foodReserves(f.bot), { carrot: 2 });
  assert.equal((await f.arbiter.run('strategy', 100, s => m.m.setGoal(null, s))).state, 'COMPLETED');
  assert.deepEqual(foodReserves(f.bot), {});
});
test('maintenance observes only existing authorized farmland and caps the plot at 25 cells', () => {
  const f = fixture(); for (let x = -2; x <= 6; x++) for (let z = -4; z <= 4; z++) f.put('farmland', x, 63, z);
  assert.equal(farmCells(f.bot, intent, policies().farming).length, 25);
  assert.equal(farmCells(f.bot, intent, { enabled: false }).length, 0);
});
test('empty cells are replanted before more crops are harvested', () => {
  const f = fixture(); f.put('farmland', 3, 63, 0); f.put('carrots', 3, 64, 0, 7);
  assert.equal(chooseFarmAction(f.bot, intent, policies()).goal.tool, 'plant_crop');
  f.slots[36] = null; assert.equal(chooseFarmAction(f.bot, intent, policies()).status, 'seed_shortage');
});
test('mature farms can bootstrap one harvest without seeds but cannot keep clearing unplanted cells', () => {
  const f = fixture(); f.slots[36] = null; f.put('carrots', 2, 64, 0, 7);
  assert.equal(chooseFarmAction(f.bot, intent, policies()).goal.tool, 'harvest_crop');
  f.put('air'); assert.equal(chooseFarmAction(f.bot, intent, policies()).status, 'seed_shortage');
});
test('growing crops and reached stock targets cause no work', () => {
  const f = fixture(); f.put('carrots', 2, 64, 0, 1);
  assert.equal(chooseFarmAction(f.bot, intent, policies()).status, 'waiting_for_growth');
  f.seed('carrot', 8); f.put('carrots', 2, 64, 0, 7);
  assert.equal(chooseFarmAction(f.bot, intent, policies()).status, 'stock_satisfied');
});
test('all crop mappings protect seeds separately from the produce target', () => {
  for (const [crop, spec] of Object.entries(FARM_CROPS)) {
    const f = fixture(); f.put(crop, 2, 64, 0, spec.age); f.seed(spec.seed, 2); if (spec.seed !== spec.produce) f.seed(spec.produce, 6, 9); else f.seed(spec.seed, 8);
    assert.equal(chooseFarmAction(f.bot, { ...intent, crop }, policies()).status, 'stock_satisfied');
  }
});
test('maintenance does not overwrite other crops or harvest immature plants', () => {
  const f = fixture(); f.put('wheat', 2, 64, 0, 7);
  assert.equal(chooseFarmAction(f.bot, intent, policies()).goal, undefined);
  f.put('carrots', 2, 64, 0, 6); assert.equal(chooseFarmAction(f.bot, intent, policies()).goal, undefined);
});
test('danger, unknown inventory, full inventory, missing terrain and revoked scope halt farm work', () => {
  for (const change of [f => { f.bot.health = 4; }, f => { f.bot.food = 8; }, f => { f.bot.entity.onGround = false; }, f => { f.bot.currentWindow = {}; }, f => { f.bot.inventory.selectedItem = {}; }, f => { f.bot.blockAt = () => null; }, f => { f.bot.entity.position = vec(50, 64, 0); }]) {
    const f = fixture(); change(f); assert.equal(chooseFarmAction(f.bot, intent, policies()).goal, undefined);
  }
  const f = fixture(); f.put('carrots', 2, 64, 0, 7); for (let slot = 9; slot < 45; slot++) f.seed('stone', 1, slot);
  assert.equal(chooseFarmAction(f.bot, intent, policies()).status, 'inventory_full');
  const p = policies(); p.navigation.enabled = false; assert.equal(chooseFarmAction(f.bot, intent, p).status, 'permission_disabled');
});
test('manager recovers a harvest that took effect despite a failed result without redigging', async () => {
  const f = fixture(); f.put('carrots', 2, 64, 0, 7); const attempted = [];
  const m = manager(f, { execute: async g => { attempted.push(g.tool); if (g.tool === 'harvest_crop') f.put('air'); return { state: 'FAILED' }; } });
  await m.m.tick(); m.advance(); await m.m.tick();
  assert.deepEqual(attempted, ['harvest_crop', 'plant_crop']);
});
test('manager reconciles a planted seedling after cancellation instead of spending another seed', async () => {
  const f = fixture(); let calls = 0;
  const m = manager(f, { execute: async () => { calls++; f.put('carrots', 2, 64, 0, 0); return { state: 'CANCELLED' }; } });
  await m.m.tick(); m.advance(); await m.m.tick(); assert.equal(calls, 1); assert.equal(m.m.status().state, 'waiting_for_growth');
});
test('retries back off and the manager never overlaps work or resumes a queued tail', async () => {
  const f = fixture(), begun = latch(), finish = latch(); let calls = 0;
  const m = manager(f, { execute: async () => { calls++; begun.resolve(); await finish.promise; return { state: 'FAILED' }; } });
  const pending = m.m.tick(); await begun.promise; m.advance(); await m.m.tick(); assert.equal(calls, 1);
  finish.resolve(); await pending; m.advance(); await m.m.tick(); assert.equal(calls, 1);
  m.advance(5000); await m.m.tick(); assert.equal(calls, 2);
});
test('a stopped manager issues no work and releases its active seed reservation', async () => {
  const f = fixture(), m = manager(f); m.m.stop(); await m.m.tick();
  assert.equal(m.goals.length, 0); assert.deepEqual(foodReserves(f.bot), {});
});
test('farm configuration refuses distant or non-farmland anchors and invalidates changed bodies during persistence', async () => {
  const f = fixture(), m = manager(f);
  assert.equal((await f.arbiter.run('strategy', 100, s => m.m.setGoal({ ...intent, x: 40 }, s))).state, 'FAILED');
  const begin = latch(), done = latch(); m.store.remember = async () => { begin.resolve(); await done.promise; };
  const pending = f.arbiter.run('strategy', 100, s => m.m.setGoal(intent, s)); await begin.promise;
  f.bot.entity = { ...f.bot.entity }; done.resolve(); assert.equal((await pending).state, 'FAILED');
});
async function diskFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'arena-farm-')); t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, agent: 'alice', worldId: 'farm-world' };
}
test('farm intentions survive restart without stored phases, targets or commands and remain world/dimension scoped', async t => {
  const settings = await diskFixture(t), store = await MemoryStore.open(settings);
  await store.remember('farm_intent', { dimension: 'overworld', position: null }, { farm: intent }); await store.close();
  const next = await MemoryStore.open(settings);
  assert.deepEqual(next.retrieveFarm({ dimension: 'overworld' }), intent); assert.equal(next.retrieveFarm({ dimension: 'the_nether' }), null);
  assert.equal(next.retrieve({ dimension: 'overworld' }).length, 0); await next.close();
  const other = await MemoryStore.open({ ...settings, worldId: 'other' }); assert.equal(other.retrieveFarm({ dimension: 'overworld' }), null); await other.close();
  const raw = JSON.parse(await readFile(join(settings.directory, 'memory.json'), 'utf8')); assert.equal(raw.schemaVersion, 12);
  assert.deepEqual(Object.keys(raw.records[0].data), ['farm']);
});
test('schema eleven migrates before writing farm intentions and stop tombstones persist', async t => {
  const settings = await diskFixture(t); await writeFile(join(settings.directory, 'memory.json'), JSON.stringify({ schemaVersion: 11, agent: 'alice', records: [] }));
  const store = await MemoryStore.open(settings); await store.remember('farm_intent', { dimension: 'overworld' }, { farm: intent });
  await store.remember('farm_intent', { dimension: 'overworld' }, { farm: null }); await store.close();
  const next = await MemoryStore.open(settings); assert.equal(next.retrieveFarm({ dimension: 'overworld' }), null); assert.equal(next.size, 1); await next.close();
});
test('corrupt persisted farming arguments cannot become maintenance authority', async t => {
  const settings = await diskFixture(t), store = await MemoryStore.open(settings);
  await assert.rejects(store.remember('farm_intent', { dimension: 'overworld' }, { farm: { ...intent, command: 'dig_everything' } })); await store.close();
});
test('a partial general plan gives the next provider fresh recovery context, not old executable arguments', async () => {
  let clock = 0, requests = 0; const contexts = [];
  const strategy = new StrategyController({ identity: {}, now: () => clock, emit: () => {},
    observe: () => ({ health: 20, food: 20, risk: { mode: 'NORMAL' }, dimension: 'overworld', position: { x: 0, y: 64, z: 0 } }),
    provider: { plan: async context => { contexts.push(context); requests++; return requests === 1 ? { reason: '', steps: [{ tool: 'wait', args: { durationMs: 100 }, reason: '' }, { tool: 'wait', args: { durationMs: 200 }, reason: '' }] } : { tool: 'scan', args: {}, reason: '' }; } },
    execute: async g => ({ state: g.args.durationMs === 200 ? 'FAILED' : 'COMPLETED' }) });
  strategy.start(); await strategy.tick(); clock = 300001; await strategy.tick();
  assert.equal(contexts[1].planRecovery.completedSteps, 1); assert.equal(contexts[1].planRecovery.reobserveRequired, true);
  assert.equal(Object.hasOwn(contexts[1].planRecovery, 'args'), false);
});
test('multiple real harvest/pickup/replant cycles reach stock, idle, then resume after stock is consumed', async () => {
  const f = fixture(); f.bot.entity.position = vec(1.65, 64, 0.5); f.put('carrots', 2, 64, 0, 7);
  const selected = { ...intent, targetStock: 10 }, store = memory(selected), p = policies();
  const registry = createToolRegistry({ farmingPolicy: p.farming, collectionPolicy: p.collection, navigationPolicy: p.navigation });
  let id = 100, clock = 0, harvests = 0; const results = [], dig = f.bot.dig, sync = f.bot._syncWindow;
  f.bot.dig = async b => {
    await dig(b); harvests++; const entityId = ++id;
    f.bot.entities[entityId] = { id: entityId, uuid: '12345678-1234-4234-8234-123456789abc', name: 'item', position: vec(2.25, 64.1, 0.5), getDroppedItem: () => ({ name: 'carrot', type: data.itemsByName.carrot.id, count: 4 }) };
  };
  f.bot._syncWindow = async () => {
    await sync(); const drop = f.bot.entities[id];
    if (drop && f.client.listenerCount('collect')) setImmediate(() => {
      if (f.bot.entities[id] !== drop) return;
      f.client.emit('collect', { collectedEntityId: drop.id, collectorEntityId: 1, pickupItemCount: 4 });
      f.seed('carrot', (f.slots[36]?.count || 0) + 4); delete f.bot.entities[drop.id];
    });
  };
  const m = new FarmManager({ bot: f.bot, memory: store, policies: p, now: () => clock, execute: async g => { const r = await registry.execute(f.bot, f.arbiter, g, {}); results.push([g.tool, r.state]); return r; } });
  m.start();
  for (let cycle = 0; cycle < 3; cycle++) {
    f.put('carrots', 2, 64, 0, 7); // Explicit simulated server growth, not predicted yield.
    for (let step = 0; step < 3; step++) { clock += 2000; await m.tick(); }
    assert.equal(f.bot.blockAt(vec(2, 64, 0)).getProperties().age, '0');
  }
  assert.equal(harvests, 3); assert.equal(f.slots[36].count, 12);
  assert.ok(results.every(([, state]) => state === 'COMPLETED')); assert.equal(results.length, 9);
  f.put('carrots', 2, 64, 0, 7); clock += 2000; await m.tick(); assert.equal(m.status().state, 'stock_satisfied'); assert.equal(harvests, 3);
  f.seed('carrot', 4); clock += 2000; await m.tick(); assert.equal(harvests, 4);
});
test('actual seedling confirmation followed by preemption is reconciled without duplicate planting', async () => {
  const f = fixture(), p = policies(); const registry = createToolRegistry({ farmingPolicy: p.farming });
  const write = f.client.write; f.client.write = (...args) => { write(...args); f.arbiter.cancel('survival'); };
  let attempts = 0;
  const m = manager(f, { execute: async g => { attempts++; return registry.execute(f.bot, f.arbiter, g, {}); } });
  await m.m.tick(); assert.equal(f.bot.blockAt(vec(2, 64, 0)).getProperties().age, '0');
  m.advance(10000); await m.m.tick(); assert.equal(attempts, 1); assert.equal(f.slots[36].count, 2);
});
test('a restarted manager derives pending replanting from the world, not a serialized old step', async t => {
  const settings = await diskFixture(t); let store = await MemoryStore.open(settings);
  await store.remember('farm_intent', { dimension: 'overworld' }, { farm: intent });
  const f = fixture(); f.put('carrots', 2, 64, 0, 7); const attempted = [];
  const first = new FarmManager({ bot: f.bot, memory: store, policies: policies(), execute: async g => { attempted.push(g.tool); f.put('air'); return { state: 'FAILED' }; } });
  first.start(); await first.tick(); first.stop(); await store.close();
  store = await MemoryStore.open(settings);
  const second = new FarmManager({ bot: f.bot, memory: store, policies: policies(), execute: async g => { attempted.push(g.tool); return { state: 'COMPLETED' }; } });
  second.start(); await second.tick(); second.stop(); await store.close();
  assert.deepEqual(attempted, ['harvest_crop', 'plant_crop']);
});
test('manager first collects seed and then produce stacks rather than pretending one pickup recovers all yield', () => {
  const f = fixture(); const w = { ...intent, crop: 'wheat' };
  for (const [id, name] of [[101, 'wheat_seeds'], [102, 'wheat']]) f.bot.entities[id] = { id, uuid: '12345678-1234-4234-8234-123456789abc', name: 'item', position: vec(1, 64.1, 0.5), getDroppedItem: () => ({ name, type: data.itemsByName[name].id, count: 2 }) };
  assert.equal(chooseFarmAction(f.bot, w, policies()).goal.args.expectedItem, 'wheat_seeds');
  delete f.bot.entities[101]; assert.equal(chooseFarmAction(f.bot, w, policies()).goal.args.expectedItem, 'wheat');
});
test('farm intentions stay bounded and survive historical record churn', async t => {
  const settings = await diskFixture(t); const store = await MemoryStore.open(settings);
  await store.remember('farm_intent', { dimension: 'overworld' }, { farm: intent });
  for (let i = 0; i < 510; i++) await store.remember('goal_result', { dimension: 'overworld' }, { tool: 'scan', state: 'COMPLETED' });
  assert.equal(store.size, 500); assert.deepEqual(store.retrieveFarm({ dimension: 'overworld' }), intent); await store.close();
});
test('a real farm goal goes through the registry and is persisted before it is reported completed', async () => {
  const f = fixture(), m = manager(f, { memory: memory(null) }), p = policies();
  const registry = createToolRegistry({ farmingPolicy: p.farming, collectionPolicy: p.collection, navigationPolicy: p.navigation, farmManagement: true });
  const result = await registry.execute(f.bot, f.arbiter, { tool: 'manage_farm', args: intent, reason: '' }, { farms: m.m });
  assert.equal(result.state, 'COMPLETED'); assert.equal(result.result.intentionPersisted, true); assert.deepEqual(m.m.intent(), intent);
});
test('runtime schedules chosen farm work between planner calls and exposes protected stock', async () => {
  const f = fixture(), events = new EventEmitter(), p = policies(), store = memory(null); let requests = 0;
  f.bot.on = events.on.bind(events); f.bot.deactivateItem = () => {}; f.bot.quit = () => {};
  store.retrieve = () => []; store.flush = async () => {};
  const runtime = attachRuntime(f.bot, () => {}, { memory: store, provider: { plan: async () => { requests++; return { tool: 'manage_farm', args: intent, reason: '' }; } }, farmingPolicy: p.farming, collectionPolicy: p.collection, navigationPolicy: p.navigation });
  events.emit('spawn'); events.emit('physicsTick'); await runtime.settle();
  assert.equal(requests, 1); assert.deepEqual(runtime.status().observation.seedReserves, { carrot: 2 });
  events.emit('physicsTick'); await runtime.settle();
  assert.equal(f.bot.blockAt(vec(2, 64, 0)).getProperties().age, '0'); assert.equal(requests, 1);
  await runtime.close();
});
test('disabling AI planning does not silently activate a saved farm on spawn', async () => {
  const f = fixture(), events = new EventEmitter(), p = policies(), store = memory();
  f.bot.on = events.on.bind(events); f.bot.deactivateItem = () => {}; f.bot.quit = () => {};
  store.retrieve = () => []; store.flush = async () => {};
  const runtime = attachRuntime(f.bot, () => {}, { memory: store, farmingPolicy: p.farming, collectionPolicy: p.collection, navigationPolicy: p.navigation });
  events.emit('spawn'); events.emit('physicsTick'); await runtime.settle(); events.emit('physicsTick'); await runtime.settle();
  assert.equal(f.bot.blockAt(vec(2, 64, 0)).name, 'air'); assert.deepEqual(runtime.status().observation.seedReserves, {});
  await runtime.close();
});
test('advisory food reserves exclude planting stock without double-subtracting separate stacks', () => {
  const result = assessNeeds({ health: 20, food: 20, risk: { mode: 'NORMAL' }, inventory: [{ name: 'carrot', count: 2 }, { name: 'carrot', count: 2 }], seedReserves: { carrot: 3 } });
  assert.equal(result.entries.find(e => e.id === 'food_reserve').evidence.safeFoodUnits, 1);
});
test('dimension changes suspend the old farm reserve and cannot authorize old farmland work', async () => {
  const f = fixture(), m = manager(f); f.bot.game.dimension = 'the_nether';
  assert.deepEqual(foodReserves(f.bot), {}); await m.m.tick(); assert.equal(m.goals.length, 0);
});
test('the worker approaches distant ripe crops before harvesting rather than scattering unreachable yield', () => {
  const f = fixture(); f.bot.entity.position = vec(0.5, 64, 0.5); f.put('carrots', 2, 64, 0, 7);
  assert.equal(chooseFarmAction(f.bot, intent, policies()).goal.tool, 'navigate_farm');
});
test('planting and harvesting work from adjacent crop-covered farmland at its real standing height', async () => {
  const f = fixture(); f.put('farmland', 1, 63, 0); f.put('carrots', 1, 64, 0, 0); f.bot.entity.position = vec(1.5, 63.9375, 0.5);
  assert.equal((await f.run()).state, 'COMPLETED');
  f.put('carrots', 2, 64, 0, 7);
  const registry = createToolRegistry({ farmingPolicy: autonomousWorldPolicy() });
  assert.equal((await registry.execute(f.bot, f.arbiter, { tool: 'harvest_crop', args: { x: 2, y: 64, z: 0, expectedCrop: 'carrots' }, reason: '' }, {})).state, 'COMPLETED');
  assert.equal(f.bot.blockAt(vec(1, 64, 0)).getProperties().age, '0');
});
test('food below the work threshold may use a reserve, avoiding a hunger/reservation deadlock', async () => {
  const f = fixture(); f.bot.food = 11; let consumed = false;
  attachSeedReserve(f.bot, () => ({ seed: 'carrot', count: 3 })); f.bot.equip = async () => {}; f.bot.consume = async () => { consumed = true; };
  const survival = new SurvivalController(f.bot, f.arbiter, () => {}); survival.start(); survival.tick(); await new Promise(r => setImmediate(r));
  assert.equal(consumed, true); survival.stop();
});
test('revoking the managed anchor scope also releases its reserve and suspends work', async () => {
  const f = fixture(), m = manager(f);
  m.m.policies.farming = { enabled: true, dimension: 'overworld', area: { minX: 30, minY: 64, minZ: 30, maxX: 40, maxY: 64, maxZ: 40 } };
  assert.deepEqual(foodReserves(f.bot), {}); await m.m.tick(); assert.equal(m.goals.length, 0);
});
test('farm geometry fails closed for NaN positions and malformed collision shapes', () => {
  const f = fixture(); assert.equal(farmSegment(worldReader(f.bot), { x: NaN, y: 64, z: 0 }, { x: NaN, y: 64, z: 0 }), false);
  const soil = f.put('farmland', 2, 63, 0); soil.shapes = [null];
  assert.equal(farmFootprint(worldReader(f.bot), vec(2.5, 63.9375, 0.5)), false);
});
test('village dirt paths share the verified one-sixteenth edge profile and do not trap farm workers', () => {
  const require = createRequire(import.meta.resolve('mineflayer')), Block = require('prismarine-block')(data);
  const path = Block.fromStateId(data.blocksByName.dirt_path.defaultState, 0);
  assert.deepEqual(path.shapes, [[0, 0, 0, 1, 15 / 16, 1]]);
  const read = p => p.y === 63 ? path : { name: 'air' };
  assert.equal(farmFootprint(read, vec(0.5, 63.9375, 0.5)), true);
});
