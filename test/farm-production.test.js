import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fixture, data, vec } from '../test-support/production-fixture.js';
import { autonomousWorldPolicy } from '../src/permissions.js';
import { tillSoil, digIrrigation, fillWaterBucket, irrigateBasin, placeFarmBlock, fertilizeCrop, checkBasin } from '../shared/tools/farm-development.js';
import { cookFood } from '../shared/tools/cook.js';
import { attachSeedReserve, seedReserve } from '../src/farming/reservations.js';
import { GrowthMonitor, hydration, growingConditions } from '../src/farming/growth.js';
import { productionLayout, reservedCell, chooseProduction } from '../src/farming/production.js';
import { FarmManager, chooseFarmAction } from '../src/farming/manager.js';
import { createToolRegistry } from '../shared/tools/index.js';
import { validateGoal, catalog } from '../src/strategy/goals.js';
import { planCraft } from '../shared/tools/craft.js';
const policy = autonomousWorldPolicy(), soil = { x: 2, y: 63, z: 0 }, furnace = { x: 2, y: 64, z: 0, item: 'potato' };
const farm = { x: 3, y: 64, z: 3, crop: 'potatoes', targetStock: 8, reserve: 2, develop: true };
const policies = { farming: policy, navigation: policy, collection: policy, workspace: policy };
const latch = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
const packets = f => f.calls.filter(([name]) => ['block_place', 'use_item', 'dig'].includes(name));
function fTest(t) { const f = fixture(); t.after(f.dispose); return f; }
function furnaceFixture(t) { const f = fTest(t); f.put('furnace', 2, 64, 0); f.seed('potato', 4, 9); f.seed('coal', 2, 10); return f; }

test('new production tool schemas reject injected scope, arbitrary blocks, counts and unsupported foods', () => {
  for (const tool of ['till_soil', 'dig_irrigation', 'fill_water_bucket', 'irrigate_basin', 'fertilize_crop', 'smelt_iron']) {
    assert.equal(validateGoal({ tool, args: soil, reason: '' }).tool, tool);
    for (const bad of [{ ...soil, x: 0.5 }, { ...soil, y: -64 }, { ...soil, count: 2 }]) assert.throws(() => validateGoal({ tool, args: bad, reason: '' }));
    assert.equal(catalog.some(t => t.name === tool), false);
  }
  assert.throws(() => validateGoal({ tool: 'place_farm_block', args: { ...soil, block: 'tnt' }, reason: '' }));
  assert.throws(() => validateGoal({ tool: 'cook_food', args: { ...furnace, item: 'raw_iron' }, reason: '' }));
});
test('combined production requires all deployment scopes but old prepared-plot goals remain unchanged', () => {
  const full = { farmingPolicy: policy, collectionPolicy: policy, navigationPolicy: policy, workspacePolicy: policy, farmManagement: true };
  assert.ok(createToolRegistry(full).catalog().some(t => t.name === 'establish_farm'));
  assert.equal(createToolRegistry({ ...full, workspacePolicy: { enabled: false } }).catalog().some(t => t.name === 'establish_farm'), false);
  assert.equal(createToolRegistry().catalog().some(t => t.name === 'till_soil'), false);
});
test('soil tilling stages a hoe from main inventory and requires server farmland confirmation', async t => {
  const f = fTest(t); f.seed('wooden_hoe', 1, 9);
  const result = await f.run(tillSoil, soil, policy);
  assert.equal(result.state, 'COMPLETED'); assert.equal(f.bot.blockAt(vec(2, 63, 0)).name, 'farmland');
  assert.ok(f.calls.some(([name, slot, , mode]) => name === 'click' && slot === 9 && mode === 2));
  assert.equal(result.result.serverBlockVerified, true);
});
test('coarse dirt takes separate verified hoe operations rather than being assumed farmland', async t => {
  const f = fTest(t); f.put('coarse_dirt'); f.seed('stone_hoe', 1);
  assert.equal((await f.run(tillSoil, soil, policy)).state, 'COMPLETED'); assert.equal(f.bot.blockAt(vec(2, 63, 0)).name, 'dirt');
  assert.equal((await f.run(tillSoil, soil, policy)).state, 'COMPLETED'); assert.equal(f.bot.blockAt(vec(2, 63, 0)).name, 'farmland');
});
test('tilling refuses crops, unsupported ground, occupied cells, missing/worn hoes and body-support removal', async t => {
  for (const change of [f => f.put('carrots', 2, 64, 0), f => f.put('stone'), f => { f.slots[36] = null; }, f => { f.slots[36].durabilityUsed = data.itemsByName.wooden_hoe.maxDurability; }, f => { f.bot.entity.position = vec(2.5, 64, 0.5); }]) {
    const f = fTest(t); f.seed('wooden_hoe', 1); change(f);
    assert.equal((await f.run(tillSoil, soil, policy)).state, 'FAILED'); assert.equal(packets(f).length, 0);
  }
});
test('irrigation excavation constructs a contained pocket without digging under the player', async t => {
  const f = fTest(t); f.seed('wooden_shovel', 1);
  const result = await f.run(digIrrigation, soil, policy); assert.equal(result.state, 'COMPLETED');
  assert.equal(f.bot.blockAt(vec(2, 63, 0)).name, 'air'); assert.equal(result.result.serverBlockVerified, true);
});
test('a dug pocket can be filled using the pinned use-item rotation, with exact bucket conversion evidence', async t => {
  const f = fTest(t); f.put('air'); f.seed('water_bucket', 1);
  const result = await f.run(irrigateBasin, soil, policy);
  assert.equal(result.state, 'COMPLETED'); assert.equal(f.bot.heldItem.name, 'bucket'); assert.equal(f.bot.blockAt(vec(2, 63, 0)).name, 'water');
  const packet = f.calls.find(([name]) => name === 'use_item')[1]; assert.ok(Number.isFinite(packet.rotation.x));
  const require = createRequire(import.meta.resolve('mineflayer')), protocol = require('minecraft-protocol');
  const serializer = protocol.createSerializer({ state: protocol.states.PLAY, isServer: false, version: '1.21.1' });
  assert.ok(serializer.createPacketBuffer({ name: 'use_item', params: packet }).length > 0);
});
test('water acquisition preserves renewable-source preconditions and verifies filled-bucket inventory', async t => {
  const f = fTest(t); f.put('water'); f.put('water', 3, 63, 0); f.put('water', 2, 63, 1); f.seed('bucket', 1);
  assert.equal((await f.run(fillWaterBucket, soil, policy)).state, 'COMPLETED'); assert.equal(f.bot.heldItem.name, 'water_bucket');
});
test('finite sources, flowing water, open channels, weak walls and Nether evaporation are refused', async t => {
  for (const change of [f => f.put('air', 3, 63, 0), f => f.put('sand', 3, 63, 0), f => f.put('farmland', 3, 63, 0), f => { f.bot.game.dimension = 'the_nether'; }]) {
    const f = fTest(t); f.put('air'); f.seed('water_bucket', 1); change(f);
    assert.equal((await f.run(irrigateBasin, soil, policy)).state, 'FAILED'); assert.equal(packets(f).length, 0);
  }
  const f = fTest(t); f.put('water'); f.seed('bucket', 1);
  assert.equal((await f.run(fillWaterBucket, soil, policy)).state, 'FAILED'); assert.equal(packets(f).length, 0);
});
test('bucket success requires both a world report and authoritative inventory conversion', async t => {
  for (const change of [f => { f.reply = false; }, f => { f.consume = false; }]) {
    const f = fTest(t); f.put('air'); f.seed('water_bucket', 1); change(f);
    assert.equal((await f.run(irrigateBasin, soil, policy)).state, 'FAILED');
    assert.equal(f.client.listenerCount('block_change'), 0); assert.equal(f.client.listenerCount('window_items'), 0);
  }
});
test('late aim, permission revocation and replaced bodies cannot issue soil interactions', async t => {
  for (const mode of ['cancel', 'permission', 'body']) {
    const f = fTest(t), entered = latch(), done = latch(), p = structuredClone(policy); f.seed('wooden_hoe', 1);
    f.bot.lookAt = async () => { entered.resolve(); await done.promise; };
    const run = f.run(tillSoil, soil, p); await entered.promise;
    if (mode === 'cancel') f.arbiter.cancel('danger'); else if (mode === 'permission') p.enabled = false; else f.bot.entity = { ...f.bot.entity };
    done.resolve(); assert.notEqual((await run).state, 'COMPLETED'); assert.equal(packets(f).length, 0);
  }
});
test('furnaces, tables, lamp supports and torches use guarded placement plus item-decrease evidence', async t => {
  for (const block of ['cobblestone', 'crafting_table', 'furnace', 'torch']) {
    const f = fTest(t); f.seed(block, 2); const args = { x: 2, y: 64, z: 0, block };
    assert.equal((await f.run(placeFarmBlock, args, policy)).state, 'COMPLETED'); assert.equal(f.bot.blockAt(vec(2, 64, 0)).name, block);
    assert.equal(f.bot.heldItem.count, 1);
  }
});
test('development placement never replaces occupied cells or opens an interactive support by accident', async t => {
  const f = fTest(t); f.seed('torch', 2); f.put('furnace', 2, 63, 0);
  assert.equal((await f.run(placeFarmBlock, { x: 2, y: 64, z: 0, block: 'torch' }, policy)).state, 'FAILED'); assert.equal(packets(f).length, 0);
});
test('one bone meal application requires a verified age increase and inventory use', async t => {
  const f = fTest(t); f.put('farmland'); f.put('carrots', 2, 64, 0, 1); f.seed('bone_meal', 3);
  assert.equal((await f.run(fertilizeCrop, { x: 2, y: 64, z: 0 }, policy)).state, 'COMPLETED');
  assert.equal(f.bot.blockAt(vec(2, 64, 0)).getProperties().age, '2'); assert.equal(f.bot.heldItem.count, 2);
});
test('cooking runs independent loading, fuel and output phases; loading alone is not cooked food', async t => {
  const f = furnaceFixture(t); f.autoCook = true;
  const run = () => f.run(cookFood, furnace, policy);
  const input = await run(); assert.equal(input.state, 'COMPLETED'); assert.equal(input.result.phase, 'input_loaded'); assert.equal(input.result.cooked, false);
  const fuel = await run(); assert.equal(fuel.state, 'COMPLETED'); assert.equal(fuel.result.phase, 'fuel_loaded');
  const output = await run(); assert.equal(output.state, 'COMPLETED'); assert.equal(output.result.phase, 'collected'); assert.equal(output.result.item, 'baked_potato');
  assert.equal(f.bot.inventory.items().find(i => i.name === 'baked_potato').count, 1); assert.equal(f.bot.currentWindow, null);
});
test('hotbar-only cooking supplies are moved via guarded empty-main-slot number-key swaps', async t => {
  const f = furnaceFixture(t); f.slots[9] = null; f.seed('potato', 4, 36);
  const result = await f.run(cookFood, furnace, policy); assert.equal(result.state, 'COMPLETED');
  assert.ok(f.calls.some(([name, slot, , mode]) => name === 'click' && slot >= 3 && slot < 30 && mode === 2));
});
test('cooking protects planting reserves and can override them for essential nutrition', async t => {
  const f = furnaceFixture(t); attachSeedReserve(f.bot, () => ({ seed: 'potato', count: 4 }));
  assert.equal((await f.run(cookFood, furnace, policy)).result.phase, 'idle');
  f.bot.food = 11; assert.equal((await f.run(cookFood, furnace, policy)).result.phase, 'input_loaded');
});
test('foreign furnace output and unsupported fuel are not silently moved or replaced', async t => {
  const f = furnaceFixture(t); f.furnaceState[2] = { name: 'stone', type: data.itemsByName.stone.id, count: 1 };
  assert.equal((await f.run(cookFood, furnace, policy)).state, 'FAILED'); assert.equal(f.calls.some(([name]) => name === 'click'), false);
});
test('cooked output can be recovered by a fresh invocation after input/fuel work was interrupted', async t => {
  const f = furnaceFixture(t); f.furnaceState[2] = { name: 'baked_potato', type: data.itemsByName.baked_potato.id, count: 1 };
  assert.equal((await f.run(cookFood, furnace, policy)).result.phase, 'collected');
});
test('ambiguous late furnace openings quarantine future opens instead of binding stale replies', async t => {
  const f = furnaceFixture(t); let sent; const entered = latch(); f.client.write = () => { sent = true; entered.resolve(); };
  const pending = f.run(cookFood, furnace, policy); await entered.promise; f.arbiter.cancel('danger'); assert.equal((await pending).state, 'CANCELLED');
  f.open(); await new Promise(r => setImmediate(r)); assert.equal(f.bot.currentWindow, null);
  assert.equal((await f.run(cookFood, furnace, policy)).state, 'FAILED'); assert.equal(sent, true);
});
test('a cancelled input transfer cannot continue with fuel or output clicks', async t => {
  const f = furnaceFixture(t), entered = latch(), done = latch(); const click = f.bot.clickWindow;
  f.bot.clickWindow = async (...args) => { await click(...args); entered.resolve(); await done.promise; };
  const pending = f.run(cookFood, furnace, policy); await entered.promise; f.arbiter.cancel('danger'); assert.equal((await pending).state, 'CANCELLED');
  const calls = f.calls.filter(([name]) => name === 'click').length; done.resolve(); await new Promise(r => setImmediate(r));
  assert.equal(f.calls.filter(([name]) => name === 'click').length, calls);
});
test('growth checks actual light and water coverage without promising random ticks', t => {
  const f = fTest(t), p = { x: 2, y: 64, z: 0 }; f.put('farmland', 2, 63, 0, 0, { moisture: '7' }); f.put('carrots', 2, 64, 0, 0);
  const above = f.put('air', 2, 65, 0); above.light = 10; above.skyLight = 0; f.put('water', 4, 63, 0);
  const c = growingConditions(f.bot, p); assert.equal(c.light, 'lit'); assert.equal(c.moisture, 7); assert.equal(c.hydration, 'covered'); assert.equal(c.growthGuaranteed, false);
  above.light = 0; assert.equal(growingConditions(f.bot, p).light, 'dark'); above.skyLight = 15; assert.equal(growingConditions(f.bot, p).light, 'sunlight_variable');
});
test('unknown coverage is not mistaken for dry soil or assured hydration', t => {
  const f = fTest(t); f.bot.blockAt = () => null;
  assert.equal(hydration(f.bot, { x: 2, y: 64, z: 0 }).state, 'unknown');
});
test('suspected growth stalls require continuous observation; age changes, gaps and dimensions reset them', t => {
  const f = fTest(t), p = { x: 2, y: 64, z: 0 }, intent = { ...farm, x: 2, z: 0, crop: 'carrots' }; f.put('carrots', 2, 64, 0, 0);
  let clock = 0; const monitor = new GrowthMonitor({ now: () => clock, stallMs: 100000 });
  assert.equal(monitor.observe(f.bot, intent, [p])[0].suspectedStall, false);
  clock = 50000; monitor.observe(f.bot, intent, [p]); clock = 100000; assert.equal(monitor.observe(f.bot, intent, [p])[0].suspectedStall, true);
  monitor.attempted(p); assert.equal(monitor.observe(f.bot, intent, [p])[0].recoveryAllowed, false);
  f.put('carrots', 2, 64, 0, 1); assert.equal(monitor.observe(f.bot, intent, [p])[0].suspectedStall, false);
  clock += 100000; assert.equal(monitor.observe(f.bot, intent, [p])[0].unchangedObservedMs, 0);
  f.bot.game.dimension = 'the_nether'; assert.equal(monitor.observe(f.bot, intent, [p])[0].unchangedObservedMs, 0);
});
test('production reserves sealed basin walls, workstations and a central supported lamp', () => {
  const l = productionLayout(farm); assert.equal(l.basin.y, farm.y - 1); assert.equal(l.lamp.y, farm.y + 1);
  assert.equal(reservedCell(farm, { x: l.basin.x + 1, y: farm.y, z: l.basin.z }), true);
  assert.equal(reservedCell(farm, farm), true); assert.equal(reservedCell({ ...farm, develop: undefined }, farm), false);
});
test('pinned crafting recipes can produce a bucket, furnace, torch and bread', t => {
  const f = fTest(t), require = createRequire(import.meta.resolve('mineflayer')), Recipe = require('prismarine-recipe')(data).Recipe;
  f.bot.recipesAll = id => Recipe.find(id, null);
  const window = { id: 4, type: 'minecraft:crafting', inventoryStart: 10, inventoryEnd: 46, slots: Array(46).fill(null), selectedItem: null };
  f.bot.currentWindow = window;
  for (const [name, ingredients] of [['bucket', [['iron_ingot', 3]]], ['furnace', [['cobblestone', 8]]], ['torch', [['coal', 1], ['stick', 1]]], ['bread', [['wheat', 3]]]]) {
    window.slots.fill(null); ingredients.forEach(([item, count], i) => { window.slots[10 + i] = { name: item, type: data.itemsByName[item].id, count }; });
    assert.equal(planCraft(f.bot, name).itemName, name);
  }
  f.bot.currentWindow = null;
});
test('integrated production develops ordinary soil, constructs irrigation, grows from limited stock and cooks food', async t => {
  const f = fTest(t), intent = { ...farm, targetStock: 2, reserve: 1 }, l = productionLayout(intent);
  f.bot.entity.position = vec(3.5, 64, 0.5);
  const baseRead = f.bot.blockAt;
  f.bot.blockAt = p => {
    const block = baseRead(p), lamp = baseRead(vec(l.lamp.x, l.lamp.y, l.lamp.z));
    if (block) block.light = lamp.name === 'torch' ? Math.max(0, 14 - Math.abs(Math.floor(p.x) - l.lamp.x) - Math.abs(Math.floor(p.y) - l.lamp.y) - Math.abs(Math.floor(p.z) - l.lamp.z)) : 0;
    return block;
  };
  for (let x = 1; x <= 5; x++) for (let z = 1; z <= 5; z++) f.put('dirt', x, 63, z);
  for (const [x, z] of [[0, -1], [-1, -1], [0, -2]]) f.put('water', x, 63, z);
  for (const [i, name] of ['crafting_table', 'furnace', 'cobblestone', 'torch', 'wooden_shovel', 'wooden_hoe', 'bucket', 'potato', 'coal'].entries()) f.seed(name, name === 'potato' ? 2 : name === 'coal' ? 4 : 1, 9 + i);
  let clock = 0, forward = false, yaw = 0, entityId = 100;
  f.bot.look = async value => { yaw = value; };
  f.bot.setControlState = (name, enabled) => { if (name === 'forward') forward = enabled; f.calls.push([name, enabled]); };
  f.bot.clearControlStates = () => { forward = false; };
  const { farmSurface } = await import('../src/farming/terrain.js'), { worldReader } = await import('../src/escape.js');
  const { navigateLocal } = await import('../shared/tools/navigate.js'), { collectItems } = await import('../shared/tools/collect.js');
  const motion = async (ms, signal) => {
    if (signal.aborted) throw new Error('cancelled'); clock += ms;
    if (forward) {
      const p = f.bot.entity.position.offset(-Math.sin(yaw) * 0.2, 0, -Math.cos(yaw) * 0.2), surface = farmSurface(worldReader(f.bot), p.x, p.z, 64);
      if (!surface) throw new Error('unsafe simulated movement'); f.bot.entity.position = vec(p.x, surface.y, p.z);
    }
    for (const entity of Object.values(f.bot.entities)) if (f.bot.entity.position.distanceTo(entity.position) <= 0.68) {
      f.client.emit('collect', { collectedEntityId: entity.id, collectorEntityId: 1, pickupItemCount: 4 });
      const slot = f.slots.findIndex((item, i) => i >= 9 && i <= 44 && item?.name === 'potato');
      const dest = slot >= 9 ? slot : f.slots.findIndex((item, i) => i >= 9 && i <= 44 && !item);
      f.seed('potato', (f.slots[dest]?.count || 0) + 4, dest); delete f.bot.entities[entity.id];
    }
  };
  const dig = f.bot.dig;
  f.bot.dig = async block => {
    await dig(block);
    if (block.name === 'potatoes') {
      const id = ++entityId;
      f.bot.entities[id] = { id, uuid: '12345678-1234-4234-8234-123456789abc', name: 'item', position: block.position.offset(0.5, 0.1, 0.5), getDroppedItem: () => ({ name: 'potato', type: data.itemsByName.potato.id, count: 4 }) };
    }
  };
  const write = f.client.write;
  f.client.write = (name, packet) => {
    if (name === 'block_place' && f.bot.heldItem?.name === 'potato') {
      const p = packet.location.offset(0, 1, 0), slot = 36 + f.bot.quickBarSlot;
      f.slots[slot].count--; if (!f.slots[slot].count) f.slots[slot] = null;
      const b = f.put('potatoes', p.x, p.y, p.z, 0);
      f.client.emit('block_change', { location: p, type: b.stateId }); return;
    }
    write(name, packet);
  };
  f.autoCook = true;
  const registry = createToolRegistry({ farmingPolicy: policy, collectionPolicy: policy, navigationPolicy: policy, workspacePolicy: policy, farmManagement: true });
  registry.tools.get('navigate_farm').run = (bot, args, s) => navigateLocal(bot, args, policy, s, { farmTerrain: true, now: () => clock, wait: motion });
  registry.tools.get('collect_items').run = (bot, args, s) => collectItems(bot, args, policy, s, { now: () => clock, wait: motion });
  let saved = null, progress = null; const results = [], states = [];
  const memory = { retrieveFarm: () => saved, retrieveFarmProgress: () => progress, remember: async (kind, observation, value) => { if (kind === 'farm_intent') saved = structuredClone(value.farm); if (kind === 'farm_progress') progress = structuredClone(value); } };
  const manager = new FarmManager({ bot: f.bot, memory, policies, now: () => clock, execute: async goal => {
    const result = await registry.execute(f.bot, f.arbiter, goal, { farms: manager }); results.push([goal.tool, result.state, result.reason]); return result;
  } });
  manager.start();
  const { develop, ...args } = intent;
  const configured = await registry.execute(f.bot, f.arbiter, { tool: 'establish_farm', args, reason: '' }, { farms: manager });
  assert.equal(configured.state, 'COMPLETED');
  for (let tick = 0; tick < 260; tick++) {
    // Explicit server simulation advances hydration and random crop ages; the
    // worker must observe these changes rather than promise or synthesize them.
    for (let x = 1; x <= 5; x++) for (let z = 1; z <= 5; z++) {
      const b = f.bot.blockAt(vec(x, 64, z)), s = f.bot.blockAt(vec(x, 63, z));
      if (s.name === 'farmland') { s.getProperties = () => ({ moisture: '7' }); s.stateId = data.blocksByName.farmland.minStateId + 7; }
      if (b.name === 'potatoes') {
        const age = Math.min(7, Number(b.getProperties().age) + 1);
        const grown = f.put('potatoes', x, 64, z, age); f.client.emit('block_change', { location: grown.position, type: grown.stateId });
      }
    }
    clock += 2000; await manager.tick(); states.push(manager.status().state);
    if (manager.status().state === 'stock_satisfied' && f.bot.inventory.items().some(i => i.name === 'baked_potato')) break;
  }
  const tools = new Set(results.filter(([, state]) => state === 'COMPLETED').map(([tool]) => tool));
  assert.deepEqual(results.filter(([, state]) => state !== 'COMPLETED'), [], JSON.stringify({ states: states.slice(-10), results: results.slice(-10) }));
  for (const name of ['place_farm_block', 'fill_water_bucket', 'dig_irrigation', 'irrigate_basin', 'till_soil', 'plant_crop', 'harvest_crop', 'collect_items', 'cook_food']) assert.ok(tools.has(name), `${name}: ${JSON.stringify({ states: states.slice(-10), results: results.slice(-10) })}`);
  assert.equal(manager.status().state, 'stock_satisfied');
  assert.equal(f.bot.blockAt(vec(l.basin.x, l.basin.y, l.basin.z)).name, 'water');
  assert.ok(f.bot.inventory.items().some(i => i.name === 'baked_potato'));
  assert.equal(f.calls.some(([name, enabled]) => ['jump', 'sprint'].includes(name) && enabled), false);
});
test('hotbar-only furnace fuel is staged and used without shift-click helpers', async t => {
  const f = furnaceFixture(t); f.slots[10] = null; f.seed('charcoal', 2, 36);
  assert.equal((await f.run(cookFood, furnace, policy)).result.phase, 'input_loaded');
  assert.equal((await f.run(cookFood, furnace, policy)).result.phase, 'fuel_loaded');
});
test('foreign fuel is rejected before inserting any new ingredients', async t => {
  const f = furnaceFixture(t); f.furnaceState[1] = { name: 'oak_planks', type: data.itemsByName.oak_planks.id, count: 2 };
  assert.equal((await f.run(cookFood, furnace, policy)).reason, 'cooking_foreign_fuel'); assert.equal(f.calls.some(([name]) => name === 'click'), false);
});
test('furnace output needs an empty main slot even when a matching stack has merge room', async t => {
  const f = furnaceFixture(t); for (let i = 9; i < 36; i++) f.seed('baked_potato', 1, i);
  f.furnaceState[2] = { name: 'baked_potato', type: data.itemsByName.baked_potato.id, count: 2 };
  assert.equal((await f.run(cookFood, furnace, policy)).reason, 'cooking_inventory_full'); assert.equal(f.calls.some(([name]) => name === 'click'), false);
});
test('raw iron uses the same verified furnace phases and can recover the final ingot without carried ore', async t => {
  const f = furnaceFixture(t); f.slots[9] = null; f.seed('raw_iron', 1, 9); f.autoCook = true;
  const args = { ...furnace, item: 'raw_iron' };
  for (const phase of ['input_loaded', 'fuel_loaded', 'collected']) assert.equal((await f.run(cookFood, args, policy)).result.phase, phase);
  assert.ok(f.bot.inventory.items().some(i => i.name === 'iron_ingot')); assert.equal(f.bot.inventory.items().some(i => i.name === 'raw_iron'), false);
});
test('server-confirmed development that changes again before inventory confirmation is not reported as current success', async t => {
  const f = fTest(t); f.seed('wooden_hoe', 1); const sync = f.bot._syncWindow; let calls = 0;
  f.bot._syncWindow = async w => { if (++calls === 2) f.put('stone'); return sync(w); };
  assert.equal((await f.run(tillSoil, soil, policy)).reason, 'development_result_changed');
});
test('water source renewal after extraction does not invalidate the already-confirmed bucket conversion', async t => {
  const f = fTest(t); f.put('water'); f.put('water', 3, 63, 0); f.put('water', 2, 63, 1); f.seed('bucket', 1);
  const write = f.client.write; f.client.write = (name, packet) => { write(name, packet); if (name === 'use_item') f.put('water'); };
  assert.equal((await f.run(fillWaterBucket, soil, policy)).state, 'COMPLETED');
});
test('unknown soil or basin walls fail closed without digging or using buckets', async t => {
  for (const fn of [tillSoil, digIrrigation, irrigateBasin]) {
    const f = fTest(t); f.seed(fn === tillSoil ? 'wooden_hoe' : fn === digIrrigation ? 'wooden_shovel' : 'water_bucket', 1);
    const read = f.bot.blockAt; f.bot.blockAt = p => Math.floor(p.x) === 2 && Math.floor(p.y) === 63 ? null : read(p);
    assert.equal((await f.run(fn, soil, policy)).state, 'FAILED'); assert.equal(packets(f).length, 0);
  }
});
test('flowing water is coverage, but is never accepted as a renewable bucket source', async t => {
  const f = fTest(t); f.put('water', 2, 63, 0, 0, { level: '1' }); f.put('water', 3, 63, 0); f.put('water', 2, 63, 1); f.seed('bucket', 1);
  assert.equal(hydration(f.bot, { x: 2, y: 64, z: 0 }).state, 'covered');
  assert.equal((await f.run(fillWaterBucket, soil, policy)).reason, 'water_source_required');
});
test('moving out of the bucket ray before reply never leads to a retrying packet tail', async t => {
  const f = fTest(t), done = latch(); f.put('air'); f.seed('water_bucket', 1);
  f.bot.lookAt = async () => { f.bot.entity.position = vec(5.5, 64, 0.5); done.resolve(); };
  assert.equal((await f.run(irrigateBasin, soil, policy)).state, 'FAILED'); assert.equal(packets(f).length, 0);
});
test('growth recovery selects finite bone meal only for observed wet, lit, immature stalled crops', t => {
  const f = fTest(t), intent = { ...farm, x: 2, z: 0 }, l = productionLayout(intent);
  for (const [p, name] of [[l.table, 'crafting_table'], [l.furnace, 'furnace'], [l.lampBase, 'cobblestone'], [l.lamp, 'torch'], [l.basin, 'water']]) f.put(name, p.x, p.y, p.z);
  f.seed('bone_meal', 2);
  const growth = [{ position: { x: 3, y: 64, z: 0 }, age: 1, suspectedStall: true, recoveryAllowed: true, light: 'lit', moisture: 7 }];
  const decide = () => chooseProduction(f.bot, intent, policies, () => null, () => true, { growth });
  assert.equal(decide().goal.tool, 'fertilize_crop'); growth[0].recoveryAllowed = false; assert.equal(decide(), null);
  growth[0].recoveryAllowed = true; growth[0].moisture = 0; assert.equal(decide(), null);
});
test('production establishes dynamic seed reserves for bare beds without changing legacy reserve semantics', t => {
  const f = fTest(t); const intent = { ...farm, x: 2, z: 0, crop: 'carrots' }; let saved = intent;
  for (const x of [1, 3]) f.put('farmland', x, 63, 0);
  const manager = new FarmManager({ bot: f.bot, memory: { retrieveFarm: () => saved }, policies }); manager.start();
  assert.equal(seedReserve(f.bot).count, 4); saved = { ...intent }; delete saved.develop;
  assert.equal(seedReserve(f.bot).count, 2);
});
test('production intent and bootstrap-yield debt persist as facts, not executable commands, across disk restart', async t => {
  const { mkdtemp, rm, readFile } = await import('node:fs/promises'), { join } = await import('node:path'), { tmpdir } = await import('node:os');
  const { MemoryStore } = await import('../src/memory/store.js');
  const directory = await mkdtemp(join(tmpdir(), 'arena-production-')), settings = { directory, agent: 'alice', worldId: 'prod-world', now: () => 1000 };
  t.after(() => rm(directory, { recursive: true, force: true }));
  const observation = { dimension: 'overworld', position: { x: 3, y: 64, z: 3 } }, store = await MemoryStore.open(settings);
  await store.remember('farm_intent', observation, { farm }); await store.remember('farm_progress', observation, { farm, bootstrapPending: true }); await store.close();
  const reopened = await MemoryStore.open(settings); t.after(() => reopened.close());
  assert.deepEqual(reopened.retrieveFarm({ dimension: 'overworld' }), farm);
  assert.deepEqual(reopened.retrieveFarmProgress({ dimension: 'overworld' }), { farm, bootstrapPending: true });
  assert.equal(reopened.retrieveFarmProgress({ dimension: 'the_nether' }), null);
  assert.equal(JSON.parse(await readFile(join(directory, 'memory.json'))).schemaVersion, 13);
  await assert.rejects(reopened.remember('farm_progress', observation, { farm: { ...farm, develop: false }, bootstrapPending: true }));
  await assert.rejects(reopened.remember('farm_progress', observation, { farm, bootstrapPending: 'true' }));
});
test('strategy receives bounded ordinary-soil site candidates, not invented terrain or guaranteed supplies', async t => {
  const f = fTest(t), { scanProductionSites } = await import('../src/farming/production.js');
  for (let x = 0; x <= 4; x++) for (let z = -2; z <= 2; z++) f.put('dirt', x, 63, z);
  const sites = scanProductionSites(f.bot, policy, policy); assert.ok(sites.some(p => p.x === 2 && p.z === 0)); assert.ok(sites.length <= 8);
  assert.equal(sites[0].resourcesGuaranteed, false);
  f.bot.blockAt = () => null; assert.deepEqual(scanProductionSites(f.bot, policy, policy), []);
});
test('missing bootstrap yield stops further crop depletion rather than replaying another harvest', t => {
  const f = fTest(t), intent = { ...farm, x: 2, z: 0, crop: 'carrots' }, l = productionLayout(intent);
  f.bot.entity.position = vec(1.5, 64, 1.5);
  for (const [p, name] of [[l.table, 'crafting_table'], [l.furnace, 'furnace'], [l.lampBase, 'cobblestone'], [l.lamp, 'torch'], [l.basin, 'water']]) f.put(name, p.x, p.y, p.z);
  for (const x of [1, 3]) { f.put('farmland', x, 63, 0); f.put('air', x, 65, 0).light = 12; }
  f.put('carrots', 1, 64, 0, 7);
  assert.equal(chooseFarmAction(f.bot, intent, policies, () => true, { bootstrapPending: true }).status, 'bootstrap_yield_missing');
  assert.equal(chooseFarmAction(f.bot, intent, policies, () => true, { bootstrapPending: false }).goal.tool, 'harvest_crop');
});
test('bucket geometry detects a sub-sample-width rim intersection instead of flooding above ground', async t => {
  const f = fTest(t); f.put('air'); f.seed('water_bucket', 1); f.bot.entity.position = vec(3.82, 64, 0.5);
  assert.equal((await f.run(irrigateBasin, soil, policy)).reason, 'development_unreachable'); assert.equal(packets(f).length, 0);
});
test('a worn hoe requests a craftable replacement instead of indefinitely retrying unsafe tilling', t => {
  const f = fTest(t), intent = { ...farm, x: 2, z: 0 }, l = productionLayout(intent);
  for (const [p, name] of [[l.table, 'crafting_table'], [l.furnace, 'furnace'], [l.lampBase, 'cobblestone'], [l.lamp, 'torch'], [l.basin, 'water']]) f.put(name, p.x, p.y, p.z);
  f.put('dirt', 3, 63, 0); f.seed('wooden_hoe', 1); f.slots[36].durabilityUsed = data.itemsByName.wooden_hoe.maxDurability - 1;
  const decision = chooseProduction(f.bot, intent, policies, () => null, () => true);
  assert.equal(decision.status, 'production_needs_hoe'); assert.equal(decision.goal.args.item, 'wooden_hoe');
});
