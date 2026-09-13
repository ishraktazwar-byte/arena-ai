import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, policy } from '../test-support/collection-fixture.js';
import { vec } from '../test-support/craft-fixture.js';
import { createToolRegistry } from '../shared/tools/index.js';
import { validateGoal, catalog } from '../src/strategy/goals.js';
import { autonomousWorldPolicy } from '../src/permissions.js';
import { StrategyController } from '../src/strategy/controller.js';
import { AttemptLedger } from '../src/strategy/attempts.js';
const goal = { tool: 'collect_nearby', args: { expectedItem: 'oak_log' }, reason: '' };
const forward = f => f.calls.filter(([key, value]) => key === 'forward' && value).length;
function latch() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('nearby collection accepts one desired item only, not a target ID, quantity, radius or permissions', () => {
  assert.equal(validateGoal(goal).tool, 'collect_nearby');
  for (const args of [{}, { expectedItem: '../private' }, { expectedItem: null }, { expectedItem: 'a'.repeat(65) }, { ...goal.args, entityId: 1 }, { ...goal.args, count: 64 }, { ...goal.args, radius: 100 }, { ...goal.args, enabled: true }]) assert.throws(() => validateGoal({ ...goal, args }));
  assert.equal(catalog.some(t => t.name === goal.tool), false);
});
test('collection scope exposes the selector without a new approval flag and copies its constraints', () => {
  assert.equal(createToolRegistry().catalog().some(t => t.name === goal.tool), false);
  assert.equal(createToolRegistry({ farmingPolicy: autonomousWorldPolicy() }).catalog().some(t => t.name === goal.tool), false);
  const p = structuredClone(policy), registry = createToolRegistry({ collectionPolicy: p }); p.area.maxX = 0;
  const tool = registry.catalog().find(t => t.name === goal.tool);
  assert.equal(tool.constraints.area.maxX, 5); assert.equal(tool.constraints.maxTargets, 1); assert.equal(tool.constraints.discoveryWaitMs, 1000);
  assert.equal(createToolRegistry({ collectionPolicy: autonomousWorldPolicy() }).catalog().find(t => t.name === goal.tool).constraints.scope, 'world');
});
test('fresh selection delegates movement and authoritative pickup evidence to the existing collector', async () => {
  const f = fixture(), result = await f.nearby();
  assert.equal(result.state, 'COMPLETED'); assert.equal(result.result.entityId, 101);
  assert.equal(result.result.serverInventoryVerified, true); assert.equal(result.result.inventoryGainObserved, 4);
  assert.equal(result.result.originClaimed, false); assert.equal(result.result.exclusiveCausalityClaimed, false);
  assert.ok(forward(f) > 0); assert.equal(f.forward, false);
  assert.equal(f.client.listenerCount('collect'), 0); assert.equal(f.client.listenerCount('window_items'), 0);
});
test('unknown registry names and disabled policy fail before waits or body motion', async () => {
  for (const [args, permission] of [[{ expectedItem: 'invented_item' }, policy], [goal.args, { enabled: false }]]) {
    const f = fixture(); let waited = false;
    assert.equal((await f.nearby({ wait: async () => { waited = true; } }, args, permission)).state, 'FAILED');
    assert.equal(waited, false); assert.equal(forward(f), 0);
  }
});
test('metadata may become available after selection begins; no ID was supplied by the plan', async () => {
  const f = fixture(); delete f.bot.entities[101]; let ticks = 0;
  f.onTick = () => { if (++ticks === 2) f.bot.entities[101] = f.target; };
  assert.equal((await f.nearby()).state, 'COMPLETED'); assert.ok(ticks > 2);
});
test('selection waits only twenty short intervals when nothing matching appears', async () => {
  const f = fixture(); delete f.bot.entities[101]; let ticks = 0;
  const result = await f.nearby({ wait: async ms => { assert.equal(ms, 50); ticks++; } });
  assert.equal(result.state, 'FAILED'); assert.equal(ticks, 20); assert.equal(forward(f), 0); assert.equal(f.snapshots, 0);
});
test('unknown item metadata can settle during the discovery interval', async () => {
  const f = fixture(); const read = f.target.getDroppedItem; f.target.getDroppedItem = () => null;
  f.onTick = () => { f.target.getDroppedItem = read; };
  assert.equal((await f.nearby()).state, 'COMPLETED');
});
test('desired-item filtering happens before the sixteen-result cap', async () => {
  const f = fixture();
  for (let id = 2; id < 30; id++) f.bot.entities[id] = { ...f.target, id, position: vec(1, 64.1, 0.5), getDroppedItem: () => ({ name: 'dirt', type: 2, count: 1 }) };
  assert.equal((await f.nearby()).state, 'COMPLETED');
});
test('discovery still obeys the 256 inspected-entity bound', async () => {
  const f = fixture(); delete f.bot.entities[101];
  for (let id = 1; id <= 256; id++) f.bot.entities[id] = { name: 'unobserved' };
  f.bot.entities[999] = { ...f.target, id: 999 };
  assert.equal((await f.nearby()).state, 'FAILED'); assert.equal(f.snapshots, 0);
});
test('nearest eligible desired item is bound once and other entities are untouched', async () => {
  const f = fixture(); f.target.position = vec(0.8, 64.1, 0.5);
  f.bot.entities[102] = { ...f.target, id: 102, position: vec(2, 64.1, 0.5) };
  const result = await f.nearby(); assert.equal(result.result.entityId, 101); assert.ok(f.bot.entities[102]);
});
test('equal-distance desired items use stable numeric ID ordering', async () => {
  const f = fixture(); f.target.position = vec(0.8, 64.1, 0.5);
  f.bot.entities[102] = { ...f.target, id: 102 };
  assert.equal((await f.nearby()).result.entityId, 101); assert.ok(f.bot.entities[102]);
});
test('a reused entity ID after selection fails rather than switching to a replacement', async () => {
  const f = fixture(); const sync = f.bot._syncWindow;
  f.bot._syncWindow = async () => { await sync(); f.bot.entities[101] = { ...f.target }; };
  assert.equal((await f.nearby()).state, 'FAILED'); assert.equal(forward(f), 0);
});
test('failure after selecting a target does not retarget another stack or retry the pickup', async () => {
  const f = fixture(); f.target.position = vec(0.8, 64.1, 0.5); f.autoPickup = false;
  f.bot.entities[102] = { ...f.target, id: 102 };
  f.onTick = () => { if (f.bot.entities[101]) f.pickup({ gain: 0 }); };
  assert.equal((await f.nearby()).state, 'FAILED'); assert.ok(f.bot.entities[102]); assert.equal(f.snapshots, 2);
});
test('body, dimension, protocol, risk and inventory changes during discovery stop selection', async () => {
  for (const change of [f => { f.bot.entity = { ...f.bot.entity }; }, f => { f.bot.game.dimension = 'the_nether'; }, f => { f.client.state = 'login'; }, f => { f.bot.health = 0; }, f => { f.bot.food = 5; }, f => { f.bot.currentWindow = { id: 2 }; }, f => { f.bot.inventory.selectedItem = { count: 1 }; }, f => { f.bot.entities[2] = { name: 'creeper', position: vec(1, 64, 1) }; }]) {
    const f = fixture(); delete f.bot.entities[101];
    f.onTick = () => { change(f); f.bot.entities[101] = f.target; };
    assert.equal((await f.nearby({}, goal.args, autonomousWorldPolicy())).state, 'FAILED');
    assert.equal(forward(f), 0); assert.equal(f.snapshots, 0);
  }
});
test('revoked permission and displacement outside the original scope are checked after discovery waits', async () => {
  for (const mode of ['revoke', 'move']) {
    const f = fixture(), p = structuredClone(policy); delete f.bot.entities[101];
    f.onTick = () => { if (mode === 'revoke') p.enabled = false; else f.bot.entity.position = vec(5.5, 64, 0.5); f.bot.entities[101] = f.target; };
    assert.equal((await f.nearby({}, goal.args, p)).state, 'FAILED'); assert.equal(f.snapshots, 0);
  }
});
test('full inventories fail immediately even if matching stacks might merge', async () => {
  const f = fixture(); for (let slot = 9; slot <= 44; slot++) f.slots[slot] = { name: 'oak_log', type: 1, count: 1 };
  assert.equal((await f.nearby()).state, 'FAILED'); assert.equal(f.snapshots, 0);
});
test('unsafe routes are not made safe by dynamic selection', async () => {
  const f = fixture(); f.setBlock(1, 63, 0, { name: 'stone_slab', boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5, 1]] });
  assert.equal((await f.nearby()).state, 'FAILED'); assert.equal(forward(f), 0);
});
test('a cancelled discovery waiter cannot select a drop when it resolves late', async () => {
  const f = fixture(), entered = latch(), finish = latch(); delete f.bot.entities[101];
  const pending = f.nearby({ wait: async () => { entered.resolve(); await finish.promise; } });
  await entered.promise; f.arbiter.cancel('survival'); assert.equal((await pending).state, 'CANCELLED');
  f.bot.entities[101] = f.target; finish.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.snapshots, 0); assert.equal(forward(f), 0);
});
test('a higher-priority safety floor prevents selection and movement entirely', async () => {
  const f = fixture(); f.arbiter.setSafetyFloor(1000, 'danger');
  assert.equal((await f.nearby()).state, 'BLOCKED'); assert.equal(f.snapshots, 0);
});
test('failed selectors join the existing scoped retry cooldown rather than busy-looping', () => {
  const ledger = new AttemptLedger({ now: () => 1000 }), observation = { dimension: 'overworld', position: { x: 0.5, y: 64, z: 0.5 } };
  ledger.record(goal, observation, 'FAILED'); assert.equal(ledger.remaining(goal, observation), 600000);
  ledger.record(goal, observation, 'COMPLETED'); assert.equal(ledger.remaining(goal, observation), 0);
});
test('registry diagnostics retain the selected stable ID and explicitly identify the selector tool', async () => {
  const f = fixture(), events = []; f.target.position = vec(0.8, 64.1, 0.5);
  // Run the actual default-time collector; simulate a server reply during its
  // pickup wait, only once its authoritative baseline has been requested.
  const sync = f.bot._syncWindow;
  f.bot._syncWindow = async () => { await sync(); if (f.snapshots === 1) setImmediate(() => f.pickup()); };
  const result = await createToolRegistry({ collectionPolicy: policy }).execute(f.bot, f.arbiter, goal, { emit: e => events.push(e) });
  assert.equal(result.state, 'COMPLETED'); assert.equal(events[0].tool, 'collect_nearby'); assert.equal(events[0].result.entityId, 101);
});
test('a missing-drop failure stops a short plan before its later action', async () => {
  const f = fixture(); delete f.bot.entities[101]; const events = [], executed = [];
  const registry = createToolRegistry({ collectionPolicy: policy });
  const strategy = new StrategyController({ toolRegistry: registry, identity: {}, emit: e => events.push(e),
    observe: () => ({ health: 20, food: 20, risk: { mode: 'NORMAL' }, dimension: 'overworld', position: { x: 0.5, y: 64, z: 0.5 } }),
    provider: { plan: async () => ({ reason: '', steps: [goal, { tool: 'wait', args: { durationMs: 100 }, reason: '' }] }) },
    execute: async g => { executed.push(g.tool); return f.nearby(); } });
  strategy.start(); await strategy.tick();
  assert.deepEqual(executed, ['collect_nearby']); assert.equal(events.some(e => e.type === 'STRATEGY-PLAN-COMPLETE'), false);
});
test('a late or clock-regressed discovery reply cannot admit a stale target', async () => {
  for (const clock of [1001, -1]) {
    const f = fixture(); delete f.bot.entities[101];
    const result = await f.nearby({ wait: async () => { f.setClock(clock); f.bot.entities[101] = f.target; } });
    assert.equal(result.state, 'FAILED'); assert.equal(f.snapshots, 0); assert.equal(forward(f), 0);
  }
});
test('a pickup by another player is not success and does not trigger a new selection', async () => {
  const f = fixture(); f.target.position = vec(0.8, 64.1, 0.5); f.autoPickup = false;
  f.onTick = () => { if (f.bot.entities[101]) f.pickup({ collector: 99 }); };
  assert.equal((await f.nearby()).state, 'FAILED'); assert.equal(f.slots[9], null);
});
test('cancellation during the selected target baseline cleans evidence listeners and blocks late movement', async () => {
  const f = fixture(), entered = latch(), finish = latch();
  f.bot._syncWindow = async () => { entered.resolve(); await finish.promise; f.client.emit('window_items', f.snapshot()); };
  const pending = f.nearby(); await entered.promise; f.arbiter.cancel('survival');
  assert.equal((await pending).state, 'CANCELLED');
  assert.equal(f.client.listenerCount('collect'), 0); assert.equal(f.client.listenerCount('window_items'), 0);
  finish.resolve(); await Promise.resolve(); await Promise.resolve(); assert.equal(forward(f), 0);
});
