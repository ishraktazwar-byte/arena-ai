import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from '../src/memory/store.js';
import { validObjective, OBJECTIVE_MAX_AGE_MS } from '../src/strategy/objectives.js';
import { validateDecision } from '../src/strategy/plans.js';
import { StrategyController } from '../src/strategy/controller.js';
import { createToolRegistry } from '../shared/tools/index.js';
const objective = { item: 'oak_planks', count: 8 };
const scan = { tool: 'scan', args: {}, reason: '' };
const plan = { objective, reason: 'private-objective-reason', steps: [scan] };
const observation = { health: 20, food: 20, risk: { mode: 'NORMAL' }, dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, inventory: [], inventoryKnown: true };
function latch() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t) {
  let time = 1000;
  const directory = await mkdtemp(join(tmpdir(), 'arena-objective-'));
  const settings = { directory, agent: 'alice', worldId: 'world-a', now: () => time };
  const store = await MemoryStore.open(settings);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, settings, directory, at: value => { time = value; } };
}
const disk = f => readFile(join(f.directory, 'memory.json'), 'utf8').then(JSON.parse);
function controller(memory, options = {}) {
  return new StrategyController({ memory, identity: {}, toolRegistry: createToolRegistry(), observe: () => structuredClone(observation), emit: () => {}, provider: { plan: async () => plan }, execute: async () => ({ state: 'COMPLETED' }), ...options });
}
test('objectives are typed finite-vocabulary stock targets, not arbitrary instructions', () => {
  assert.equal(validObjective(objective), true); assert.equal(validObjective(null), true);
  for (const bad of [{ item: 'secret-custom-text', count: 1 }, { item: 'oak_planks', count: 0 }, { item: 'oak_planks', count: 65 }, { item: 'oak_planks', count: 1.5 }, { ...objective, code: 'run' }, [], 'collect wood', undefined]) assert.equal(validObjective(bad), false);
});
test('optional objective metadata preserves legacy plan/goal compatibility and copy isolation', () => {
  assert.deepEqual(validateDecision(scan), scan);
  assert.deepEqual(validateDecision({ reason: '', steps: [scan] }), { reason: '', steps: [scan] });
  const input = structuredClone(plan), output = validateDecision(input); input.objective.count = 64;
  assert.equal(output.objective.count, 8); assert.equal(validateDecision({ ...plan, objective: null }).objective, null);
  assert.throws(() => validateDecision({ ...plan, objective: { ...objective, permission: 'world' } }));
});
test('supply intention survives restart but contains no executable plan to replay', async t => {
  const f = await fixture(t); await f.store.remember('objective', observation, { objective }); await f.store.close();
  const reopened = await MemoryStore.open(f.settings);
  try {
    const result = reopened.retrieveObjective(observation); assert.equal(result.item, 'oak_planks'); assert.equal(result.state, 'active');
    assert.equal(result.requiresFreshPlan, true); assert.equal(result.source, 'cloud_intent'); assert.equal('steps' in result, false);
    assert.equal(reopened.retrieve(observation).some(record => record.kind === 'objective'), false);
  } finally { await reopened.close(); }
});
test('stock satisfaction is recomputed from observed inventory, not a previous action result', async t => {
  const f = await fixture(t); await f.store.remember('objective', observation, { objective });
  await f.store.remember('goal_result', observation, { tool: 'craft', state: 'COMPLETED' });
  assert.equal(f.store.retrieveObjective(observation).state, 'active');
  const stocked = { ...observation, inventory: [{ name: 'oak_planks', count: 4 }, { name: 'oak_planks', count: 4 }] };
  assert.equal(f.store.retrieveObjective(stocked).state, 'satisfied_now');
  assert.equal(f.store.retrieveObjective(stocked).inventoryEvidence, 'local_observation');
  assert.equal(f.store.retrieveObjective(observation).state, 'active');
});
test('unknown, invalid or sparse inventory never claims stock satisfaction', async t => {
  const f = await fixture(t); await f.store.remember('objective', observation, { objective });
  const sparse = [{ name: 'oak_planks', count: 8 }]; sparse.length = 2;
  for (const inventory of [null, undefined, [{ name: 'oak_planks', count: 99 }], sparse]) {
    const result = f.store.retrieveObjective({ ...observation, inventory }); assert.equal(result.state, 'unknown'); assert.equal(result.observedCount, null);
  }
  assert.equal(f.store.retrieveObjective({ ...observation, inventoryKnown: false }).state, 'unknown');
});
test('replacement and explicit abandonment update one objective per world/dimension', async t => {
  const f = await fixture(t); await f.store.remember('objective', observation, { objective });
  await f.store.remember('objective', observation, { objective: { item: 'stick', count: 4 } });
  assert.equal(f.store.retrieveObjective(observation).item, 'stick');
  assert.equal((await disk(f)).records.filter(record => record.kind === 'objective').length, 1);
  await f.store.remember('objective', observation, { objective: null }); assert.equal(f.store.retrieveObjective(observation), null);
  await f.store.close(); const reopened = await MemoryStore.open(f.settings);
  try { assert.equal(reopened.retrieveObjective(observation), null); } finally { await reopened.close(); }
});
test('objectives stay isolated across worlds and dimensions', async t => {
  const f = await fixture(t); await f.store.remember('objective', observation, { objective });
  assert.equal(f.store.retrieveObjective({ ...observation, dimension: 'the_nether' }), null);
  await f.store.close(); const other = await MemoryStore.open({ ...f.settings, worldId: 'world-b' });
  try { assert.equal(other.retrieveObjective(observation), null); } finally { await other.close(); }
});
test('objectives expire after twenty-four hours and future timestamps are not treated as current', async t => {
  const f = await fixture(t); await f.store.remember('objective', observation, { objective });
  f.at(999); assert.equal(f.store.retrieveObjective(observation), null);
  await assert.rejects(f.store.remember('objective', observation, { objective: null }), /memory_write_failed/);
  f.at(1000 + OBJECTIVE_MAX_AGE_MS - 1); assert.equal(f.store.retrieveObjective(observation).state, 'active');
  f.at(1000 + OBJECTIVE_MAX_AGE_MS); assert.equal(f.store.retrieveObjective(observation), null);
});
test('retrieved objective and input data cannot mutate stored intent', async t => {
  const f = await fixture(t), target = { ...objective };
  const pending = f.store.remember('objective', observation, { objective: target }); target.count = 1; await pending;
  const result = f.store.retrieveObjective(observation); result.count = 3;
  assert.equal(f.store.retrieveObjective(observation).count, 8);
});
test('objective records are pinned within the total cap rather than evicted by routine observations', async t => {
  const f = await fixture(t); await f.store.remember('spawn', observation); const envelope = await disk(f); await f.store.close();
  const seed = envelope.records[0]; envelope.records = Array.from({ length: 500 }, () => ({ ...seed, id: randomUUID() }));
  await writeFile(join(f.directory, 'memory.json'), JSON.stringify(envelope));
  const reopened = await MemoryStore.open(f.settings);
  try {
    await reopened.remember('objective', observation, { objective });
    await reopened.remember('observation', observation); assert.equal(reopened.size, 500);
    assert.equal(reopened.retrieveObjective(observation).item, 'oak_planks');
  } finally { await reopened.close(); }
});
test('only eight world/dimension objective slots are retained', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) await f.store.remember('objective', { ...observation, dimension: `test-${i}` }, { objective });
  assert.equal((await disk(f)).records.filter(record => record.kind === 'objective').length, 8);
});
test('legacy schema-v7 event history upgrades before adding objectives', async t => {
  const f = await fixture(t); await f.store.remember('spawn', observation); await f.store.close();
  const prior = await disk(f); prior.schemaVersion = 7;
  await writeFile(join(f.directory, 'memory.json'), JSON.stringify(prior));
  const reopened = await MemoryStore.open(f.settings);
  try { await reopened.remember('objective', observation, { objective }); assert.equal((await disk(f)).schemaVersion, 8); assert.equal(reopened.retrieve(observation)[0].kind, 'spawn'); }
  finally { await reopened.close(); }
});
test('corrupt objective records recover from a valid backup', async t => {
  const f = await fixture(t); await f.store.remember('objective', observation, { objective }); await f.store.remember('observation', observation); await f.store.close();
  const bad = await disk(f); bad.records.find(record => record.kind === 'objective').data.objective.item = 'private-free-text';
  await writeFile(join(f.directory, 'memory.json'), JSON.stringify(bad));
  const reopened = await MemoryStore.open(f.settings);
  try { assert.equal(reopened.recovered, true); assert.equal(reopened.retrieveObjective(observation).item, 'oak_planks'); }
  finally { await reopened.close(); }
});
test('failed objective writes keep previously committed intent and allow later writes', async t => {
  const f = await fixture(t); await f.store.remember('objective', observation, { objective });
  const atomic = f.store.atomicWrite.bind(f.store);
  f.store.atomicWrite = async () => { throw new Error('private-path'); };
  await assert.rejects(f.store.remember('objective', observation, { objective: null }), /memory_write_failed/);
  assert.equal(f.store.retrieveObjective(observation).item, 'oak_planks');
  f.store.atomicWrite = atomic; await f.store.remember('objective', observation, { objective: null });
  assert.equal(f.store.retrieveObjective(observation), null);
});
test('provider receives persisted intent on the next cycle without saved commands or raw rationale', async t => {
  const f = await fixture(t), events = []; let time = 0, calls = 0, nextContext;
  const c = controller(f.store, { now: () => time, emit: event => events.push(event), provider: { plan: async context => { calls++; nextContext = context; return calls === 1 ? plan : scan; } } });
  c.start(); await c.tick(); time = 300000; await c.tick();
  assert.equal(nextContext.objective.item, 'oak_planks'); assert.equal(nextContext.objective.requiresFreshPlan, true);
  assert.ok(nextContext.objectiveOptions.items.includes('oak_planks'));
  assert.equal(JSON.stringify(await disk(f)).includes('private-objective-reason'), false);
  assert.equal(JSON.stringify(events).includes('private-objective-reason'), false);
});
test('plans with forbidden steps cannot persist a new objective', async t => {
  const f = await fixture(t);
  const c = controller(f.store, { provider: { plan: async () => ({ ...plan, steps: [{ tool: 'navigate_local', args: { x: 1, z: 1 }, reason: '' }] }) } });
  c.start(); await c.tick(); assert.equal(f.store.retrieveObjective(observation), null);
});
test('provider staleness prevents objective persistence as well as execution', async t => {
  const f = await fixture(t), entered = latch(), finish = latch(); let executed = 0;
  const c = controller(f.store, { provider: { plan: async () => { entered.resolve(); await finish.promise; return plan; } }, execute: async () => { executed++; return { state: 'COMPLETED' }; } });
  c.start(); const pending = c.tick(); await entered.promise; c.stop(); finish.resolve(); await pending;
  assert.equal(f.store.retrieveObjective(observation), null); assert.equal(executed, 0);
});
test('lifecycle invalidation during objective storage prevents action execution', async () => {
  const entered = latch(), finish = latch(); let executed = 0;
  const memory = { retrieve: () => [], remember: async kind => { if (kind === 'objective') { entered.resolve(); await finish.promise; } } };
  const c = controller(memory, { execute: async () => { executed++; return { state: 'COMPLETED' }; } });
  c.start(); const pending = c.tick(); await entered.promise; c.stop(); finish.resolve(); await pending;
  assert.equal(executed, 0);
});
test('movement, danger or hunger during objective storage prevent acting on old context', async () => {
  for (const change of [current => { current.position.x += 4; }, current => { current.risk.mode = 'HALT'; }, current => { current.food = 4; }]) {
    const current = structuredClone(observation); let executed = 0;
    const c = controller({ retrieve: () => [], remember: async kind => { if (kind === 'objective') change(current); } }, { observe: () => structuredClone(current), execute: async () => { executed++; return { state: 'COMPLETED' }; } });
    c.start(); await c.tick(); assert.equal(executed, 0);
  }
});
test('objective read failures are sanitized and do not remove tool-level permissions', async () => {
  const events = []; let executed;
  const c = controller({ retrieve: () => [], remember: async () => {}, retrieveObjective: () => { throw new Error('private-path'); } }, { provider: null, emit: event => events.push(event), execute: async goal => { executed = goal; return { state: 'COMPLETED' }; } });
  c.start(); await c.tick(); assert.equal(executed.tool, 'scan'); assert.ok(events.some(event => event.code === 'objective_read_failed'));
  assert.equal(JSON.stringify(events).includes('private-path'), false);
});
test('duplicate objective scopes and legacy-labelled objective records recover rather than silently loading', async t => {
  for (const kind of ['duplicate', 'legacy']) {
    const f = await fixture(t); await f.store.remember('objective', observation, { objective }); await f.store.remember('observation', observation); await f.store.close();
    const bad = await disk(f);
    if (kind === 'duplicate') bad.records.push({ ...bad.records.find(record => record.kind === 'objective'), id: randomUUID() });
    else bad.schemaVersion = 7;
    await writeFile(join(f.directory, 'memory.json'), JSON.stringify(bad));
    const reopened = await MemoryStore.open(f.settings);
    try { assert.equal(reopened.recovered, true); assert.equal(reopened.retrieveObjective(observation).item, 'oak_planks'); }
    finally { await reopened.close(); }
  }
});
test('serialized concurrent updates leave exactly the latest accepted objective', async t => {
  const f = await fixture(t);
  await Promise.all([f.store.remember('objective', observation, { objective }), f.store.remember('objective', observation, { objective: { item: 'stick', count: 4 } })]);
  assert.equal(f.store.retrieveObjective(observation).item, 'stick');
  assert.equal((await disk(f)).records.filter(record => record.kind === 'objective').length, 1);
});
test('a plan omitting objective metadata does not silently erase a persisted intention', async t => {
  const f = await fixture(t); await f.store.remember('objective', observation, { objective });
  const c = controller(f.store, { provider: { plan: async () => ({ reason: '', steps: [scan] }) } });
  c.start(); await c.tick(); assert.equal(f.store.retrieveObjective(observation).item, 'oak_planks');
});
