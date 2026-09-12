import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { ControlArbiter } from '../src/control.js';
import { collectItems, scanItems } from '../shared/tools/collect.js';
import { createToolRegistry } from '../shared/tools/index.js';
import { validateGoal } from '../src/strategy/goals.js';
import { parseConfig } from '../src/config.js';
import { vec } from '../test-support/craft-fixture.js';

const uuid = '12345678-1234-4234-8234-123456789abc';
const args = { entityId: 101, entityUuid: uuid, expectedItem: 'oak_log' };
const policy = { enabled: true, dimension: 'overworld', area: { minX: -5, minY: 64, minZ: -5, maxX: 5, maxY: 64, maxZ: 5 } };
function latch() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  let clock = 0, yaw = 0, forward = false;
  const client = new EventEmitter(); client.state = 'play';
  const item = { name: 'oak_log', type: 1, count: 4 };
  const target = { id: 101, uuid, name: 'item', isValid: true, position: vec(2.5, 64.1, 0.5), getDroppedItem: () => ({ ...item }) };
  const slots = Array(46).fill(null), calls = [], changes = new Map();
  const bot = {
    version: '1.21.1', _client: client, entity: { id: 1, position: vec(0.5, 64, 0.5), onGround: true }, entities: { 101: target },
    health: 20, food: 20, oxygenLevel: 20, currentWindow: null, game: { dimension: 'overworld' },
    inventory: { slots, selectedItem: null, items: () => slots.slice(9, 45).filter(Boolean) },
    registry: { itemsByName: { oak_log: { id: 1, stackSize: 64 }, dirt: { id: 2, stackSize: 64 } } },
    blockAt: p => changes.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? (Math.floor(p.y) < 64 ? { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : { name: 'air' }),
    look: async y => { yaw = y; calls.push(['look']); },
    setControlState: (key, value) => { if (key === 'forward') forward = value; calls.push([key, value]); },
    clearControlStates: () => { forward = false; calls.push(['stop']); }
  };
  const snapshot = () => ({ windowId: 0, items: slots.map(item => item ? { itemId: item.type, itemCount: item.count } : { itemCount: 0 }), carriedItem: { itemCount: 0 } });
  let snapshots = 0;
  bot._syncWindow = async () => { snapshots++; client.emit('window_items', snapshot()); };
  function pickup({ collector = bot.entity.id, count = item.count, gain = count, remove = true, id = 101 } = {}) {
    client.emit('collect', { collectedEntityId: id, collectorEntityId: collector, pickupItemCount: count });
    if (collector === bot.entity.id && gain > 0) slots[9] = { name: 'oak_log', type: 1, count: (slots[9]?.count || 0) + gain };
    if (remove) delete bot.entities[id];
  }
  const f = { bot, target, item, slots, calls, client, pickup, snapshot, autoPickup: true, onTick: null, get snapshots() { return snapshots; }, get forward() { return forward; } };
  const wait = async (ms, signal) => {
    if (signal.aborted) throw new Error('cancelled');
    clock += ms;
    if (forward) bot.entity.position = bot.entity.position.offset(-Math.sin(yaw) * 0.2, 0, -Math.cos(yaw) * 0.2);
    f.onTick?.();
    if (f.autoPickup && bot.entities[101] && Math.hypot(bot.entity.position.x - target.position.x, bot.entity.position.z - target.position.z) <= 0.65) pickup();
  };
  const arbiter = new ControlArbiter(bot.clearControlStates);
  const run = (options = {}, goal = args, permission = policy) => arbiter.run('strategy', 100, session => collectItems(bot, goal, permission, session, { now: () => clock, wait, ...options }), 10000);
  Object.assign(f, { arbiter, run, wait, setBlock: (x, y, z, value) => changes.set(`${x},${y},${z}`, value), setClock: value => { clock = value; } });
  return f;
}
function forwardCount(f) { return f.calls.filter(([key, value]) => key === 'forward' && value).length; }

test('collection schema requires exact stable identity and forbids extra action fields', () => {
  assert.equal(validateGoal({ tool: 'collect_items', args, reason: '' }).tool, 'collect_items');
  for (const bad of [{ ...args, entityId: -1 }, { ...args, entityId: 0.1 }, { ...args, entityUuid: 'unknown' }, { ...args, expectedItem: '../secret' }, { ...args, count: 64 }]) assert.throws(() => validateGoal({ tool: 'collect_items', args: bad, reason: '' }));
});
test('collection is separately opt-in, with copied constraints and read-only discovery always available', async () => {
  const p = structuredClone(policy), registry = createToolRegistry({ collectionPolicy: p });
  p.area.maxX = 0;
  assert.equal(registry.catalog().find(t => t.name === 'collect_items').constraints.area.maxX, 5);
  assert.equal(createToolRegistry().catalog().some(t => t.name === 'collect_items'), false);
  assert.equal(createToolRegistry().catalog().some(t => t.name === 'scan_items'), true);
  const f = fixture();
  await assert.rejects(createToolRegistry().execute(f.bot, f.arbiter, { tool: 'collect_items', args, reason: '' }, {}));
  const result = await registry.execute(f.bot, f.arbiter, { tool: 'scan_items', args: {}, reason: '' }, {});
  assert.equal(result.result.items[0].eligible, true); assert.equal(forwardCount(f), 0);
});
test('drop scanning is bounded and never exposes item NBT or invented ownership', () => {
  const f = fixture(); f.item.nbt = { secret: 'private-item-name' };
  for (let i = 102; i < 145; i++) f.bot.entities[i] = { ...f.target, id: i };
  const result = scanItems(f.bot, policy);
  assert.equal(result.items.length, 16); assert.equal(result.ownership, 'not_observable');
  assert.equal(JSON.stringify(result).includes('private-item-name'), false);
});
test('missing metadata, bad UUIDs, non-item entities, wrong item types and hidden drops are excluded', () => {
  const cases = [f => { f.target.getDroppedItem = () => null; }, f => { f.target.getDroppedItem = () => { throw new Error('not ready'); }; }, f => { f.target.uuid = ''; }, f => { f.target.name = 'cow'; }, f => { f.item.type = 9; }, f => { f.setBlock(1, 64, 0, { name: 'stone' }); f.setBlock(1, 65, 0, { name: 'stone' }); }];
  for (const change of cases) { const f = fixture(); change(f); assert.equal(scanItems(f.bot, policy).items.length, 0); }
});
test('safe movement collects one stack and confirms pickup plus authoritative inventory gain', async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.result.serverPickupCount, 4); assert.equal(result.result.inventoryGainObserved, 4);
  assert.equal(result.result.serverInventoryVerified, true); assert.equal(result.result.partialPickup, false);
  assert.ok(forwardCount(f) > 0); assert.equal(f.forward, false);
  assert.equal(f.client.listenerCount('collect'), 0); assert.equal(f.client.listenerCount('window_items'), 0);
});
test('partial pickup and incidental same-type gains remain distinguishable', async () => {
  for (const gain of [2, 3]) {
    const f = fixture(); f.autoPickup = false;
    f.onTick = () => { if (f.bot.entities[101]) f.pickup({ count: 2, gain }); };
    const result = await f.run();
    assert.equal(result.state, 'COMPLETED'); assert.equal(result.result.partialPickup, true);
    assert.equal(result.result.inventoryGainObserved, gain); assert.equal(result.result.inventoryDeltaMatchesPickup, gain === 2);
    assert.equal(result.result.exclusiveCausalityClaimed, false);
  }
});
test('pickup animation/report without inventory gain is not success', async () => {
  const f = fixture(); f.autoPickup = false;
  f.onTick = () => { if (f.bot.entities[101]) f.pickup({ gain: 0 }); };
  assert.equal((await f.run()).state, 'FAILED'); assert.equal(f.forward, false);
});
test('inventory gain or entity disappearance without target pickup evidence is not success', async () => {
  const f = fixture(); f.autoPickup = false;
  f.onTick = () => { f.slots[9] = { name: 'oak_log', type: 1, count: 4 }; delete f.bot.entities[101]; };
  assert.equal((await f.run()).state, 'FAILED'); assert.equal(f.forward, false);
});
test('another collector or an unrelated collected entity cannot satisfy the target goal', async () => {
  for (const pickup of [{ collector: 99 }, { id: 102 }]) {
    const f = fixture(); f.autoPickup = false;
    f.onTick = () => { f.pickup(pickup); delete f.bot.entities[101]; };
    assert.equal((await f.run()).state, 'FAILED');
  }
});
test('UUID mismatch and reused entity objects prevent stale target execution', async () => {
  const f = fixture(); assert.equal((await f.run({}, { ...args, entityUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })).state, 'FAILED');
  assert.equal(forwardCount(f), 0);
  const g = fixture(); g.autoPickup = false; g.onTick = () => { g.bot.entities[101] = { ...g.target }; };
  assert.equal((await g.run()).state, 'FAILED');
});
test('full inventory is refused even when a same-name partial stack exists', async () => {
  const f = fixture(); for (let i = 9; i < 45; i++) f.slots[i] = { name: 'oak_log', type: 1, count: 1 };
  assert.equal((await f.run()).state, 'FAILED'); assert.equal(forwardCount(f), 0);
});
test('danger, airborne body, open inventory window and changed dimension halt collection', async () => {
  for (const change of [f => { f.bot.health = 5; }, f => { f.bot.entity.onGround = false; }, f => { f.bot.currentWindow = { id: 4 }; }, f => { f.bot.entities[2] = { name: 'creeper', position: vec(1, 64, 0.5) }; }, f => { f.bot.game.dimension = 'the_nether'; }]) {
    const f = fixture(); change(f); assert.equal((await f.run()).state, 'FAILED'); assert.equal(forwardCount(f), 0);
  }
});
test('cliffs and unknown support prevent unsafe approach', async () => {
  const f = fixture(); f.setBlock(1, 63, 0, { name: 'air' });
  assert.equal((await f.run()).state, 'FAILED'); assert.equal(forwardCount(f), 0);
  const g = fixture(); g.bot.blockAt = () => null;
  assert.equal((await g.run()).state, 'FAILED');
});
test('target above ground or outside approved area is not chased', async () => {
  const f = fixture(); f.target.position = vec(2.5, 66, 0.5);
  assert.equal((await f.run()).state, 'FAILED');
  const g = fixture(); assert.equal((await g.run({}, args, { ...policy, area: { ...policy.area, maxX: 1 } })).state, 'FAILED');
  assert.equal(forwardCount(g), 0);
});
test('path checks include the player footprint at collection area boundaries', async () => {
  const f = fixture(); f.bot.entity.position = vec(0.1, 64, 0.5);
  assert.equal((await f.run({}, args, { ...policy, area: { ...policy.area, minX: 0 } })).state, 'FAILED');
  assert.equal(forwardCount(f), 0);
});
test('moved targets are re-observed rather than following stale step endpoints', async () => {
  const f = fixture(); f.autoPickup = false; let moved = false;
  f.onTick = () => {
    if (!moved) { f.target.position = vec(2.5, 64.1, 1.5); moved = true; }
    if (Math.hypot(f.bot.entity.position.x - f.target.position.x, f.bot.entity.position.z - f.target.position.z) <= 0.65) f.pickup();
  };
  assert.equal((await f.run()).state, 'COMPLETED'); assert.ok(f.calls.filter(c => c[0] === 'look').length >= 2);
});
test('moving item leaving the collection area aborts the attempt', async () => {
  const f = fixture(); f.autoPickup = false; f.onTick = () => { f.target.position = vec(7, 64.1, 0.5); };
  assert.equal((await f.run()).state, 'FAILED'); assert.equal(f.forward, false);
});
test('a new hostile or changed terrain during movement stops controls', async () => {
  for (const update of [f => { f.bot.entities[2] = { name: 'zombie', position: vec(1, 64, 1) }; }, f => { f.setBlock(1, 63, 0, { name: 'lava' }); }]) {
    const f = fixture(); f.autoPickup = false; f.onTick = () => update(f);
    assert.equal((await f.run()).state, 'FAILED'); assert.equal(f.forward, false);
  }
});
test('no pickup report is bounded even when already in pickup range', async () => {
  const f = fixture(); f.autoPickup = false; f.target.position = vec(0.8, 64.1, 0.5);
  assert.equal((await f.run()).state, 'FAILED'); assert.equal(forwardCount(f), 0);
});
test('movement budget is enforced even if a mocked movement helper makes no progress', async () => {
  const f = fixture(); let steps = 0;
  assert.equal((await f.run({ move: async () => { steps++; } })).state, 'FAILED'); assert.equal(steps, 5);
});
test('preemption during aiming prevents stale movement and removes pickup listener immediately', async () => {
  const f = fixture(), began = latch(), finish = latch();
  f.bot.look = async () => { began.resolve(); await finish.promise; };
  const pending = f.run(); await began.promise;
  await f.arbiter.run('reflex', 1000, async () => {});
  assert.equal((await pending).state, 'CANCELLED'); assert.equal(f.client.listenerCount('collect'), 0);
  finish.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(forwardCount(f), 0);
});
test('cancellation while awaiting baseline snapshot never starts movement', async () => {
  const f = fixture(), began = latch(), finish = latch();
  f.bot._syncWindow = async () => { began.resolve(); await finish.promise; f.client.emit('window_items', f.snapshot()); };
  const pending = f.run(); await began.promise; f.arbiter.cancel('death');
  assert.equal((await pending).state, 'CANCELLED'); finish.resolve(); await Promise.resolve();
  assert.equal(forwardCount(f), 0); assert.equal(f.client.listenerCount('collect'), 0);
});
test('local slot changes without raw authoritative inventory packets cannot confirm a pickup', async () => {
  const f = fixture(); let syncs = 0;
  f.bot._syncWindow = async () => { syncs++; if (syncs === 1) f.client.emit('window_items', f.snapshot()); };
  assert.equal((await f.run()).state, 'FAILED'); assert.equal(f.forward, false);
});
test('pickup occurring before baseline snapshot completes is not attributed to this attempt', async () => {
  const f = fixture();
  f.bot._syncWindow = async () => { f.pickup(); f.client.emit('window_items', f.snapshot()); };
  assert.equal((await f.run()).state, 'FAILED'); assert.equal(forwardCount(f), 0);
});
test('collection permissions are independent of mining/workspace settings', () => {
  const env = { MC_HOST: 'example.org', MC_AUTH: 'offline' };
  assert.equal(parseConfig(env, 'alice').collectionPolicy.enabled, false);
  assert.throws(() => parseConfig({ ...env, MC_COLLECTION_ENABLED: 'true' }, 'alice'));
  const config = parseConfig({ ...env, MC_COLLECTION_ENABLED: 'true', MC_COLLECTION_AREA: '-5,64,-5,5,64,5' }, 'alice');
  assert.equal(config.collectionPolicy.enabled, true); assert.equal(config.miningPolicy.enabled, false); assert.equal(config.workspacePolicy.enabled, false);
});
test('pinned entity metadata and collect packet contracts match Minecraft 1.21.1', () => {
  const fromMineflayer = createRequire(import.meta.resolve('mineflayer'));
  const registry = fromMineflayer('prismarine-registry')('1.21.1');
  const Entity = fromMineflayer('prismarine-entity')(registry);
  const Item = fromMineflayer('prismarine-item')(registry);
  const entity = new Entity(101); entity.name = 'item'; entity.uuid = uuid;
  entity.metadata[registry.supportFeature('metadataIxOfItem')] = Item.toNotch(new Item(registry.itemsByName.oak_log.id, 4));
  assert.equal(entity.getDroppedItem().name, 'oak_log'); assert.equal(entity.getDroppedItem().count, 4);
  const protocol = fromMineflayer('minecraft-protocol');
  const serializer = protocol.createSerializer({ state: protocol.states.PLAY, isServer: true, version: '1.21.1' });
  const bytes = serializer.createPacketBuffer({ name: 'collect', params: { collectedEntityId: 101, collectorEntityId: 1, pickupItemCount: 4 } });
  assert.ok(bytes.length > 0);
});
test('collection failures produce bounded event diagnostics', async () => {
  const f = fixture(), events = []; f.bot.health = 5;
  const registry = createToolRegistry({ collectionPolicy: policy });
  const result = await registry.execute(f.bot, f.arbiter, { tool: 'collect_items', args, reason: '' }, { emit: event => events.push(event) });
  assert.equal(result.state, 'FAILED'); assert.equal(result.reason, 'collection_unsafe_body');
  assert.equal(events[0].type, 'COLLECTION-RESULT'); assert.equal(events[0].reason, result.reason);
});
