import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from '../src/memory/store.js';
import { resourceSightings, RESOURCE_MAX_AGE_MS } from '../src/memory/resources.js';
import { StrategyController } from '../src/strategy/controller.js';
import { createToolRegistry } from '../shared/tools/index.js';

const block = (name = 'oak_log', x = 1, y = 64, z = 1) => ({ name, position: { x, y, z }, visibility: 'line_of_sight_sampled', distance: 1 });
const observation = { health: 20, food: 20, dimension: 'overworld', position: { x: 0.5, y: 64, z: 0.5 }, nearbyResources: [block()] };
const noScan = { ...observation, nearbyResources: [] };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'arena-resources-'));
  let time = 1000;
  const settings = { directory, agent: 'alice', worldId: 'world-a', now: () => time };
  const store = await MemoryStore.open(settings);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, settings, directory, at: value => { time = value; } };
}
async function saved(f) { return JSON.parse(await readFile(join(f.directory, 'memory.json'), 'utf8')); }

test('resource locations persist across restart and remain historical until locally re-observed', async t => {
  const f = await fixture(t); await f.store.remember('observation', observation); await f.store.close();
  const reopened = await MemoryStore.open(f.settings);
  try {
    const historical = reopened.retrieveResources(noScan)[0];
    assert.equal(historical.block, 'oak_log'); assert.deepEqual(historical.position, block().position);
    assert.equal(historical.verification, 'historical_recheck_required'); assert.equal(historical.executionRecheckRequired, true);
    assert.equal(reopened.retrieveResources(observation)[0].verification, 'matches_current_observation');
    assert.equal(reopened.retrieveResources(observation)[0].executionRecheckRequired, true);
    assert.equal(reopened.retrieve(observation).some(record => record.kind === 'resource_sighting'), false);
  } finally { await reopened.close(); }
});
test('repeated sightings upsert a location rather than inventing extra resource quantities', async t => {
  const f = await fixture(t); await f.store.remember('spawn', observation);
  const id = (await saved(f)).records.find(record => record.kind === 'resource_sighting').id;
  f.at(2000); await f.store.remember('observation', observation);
  const records = (await saved(f)).records.filter(record => record.kind === 'resource_sighting');
  assert.equal(records.length, 1); assert.equal(records[0].id, id); assert.equal(records[0].at, 2000);
  assert.equal('count' in f.store.retrieveResources(noScan)[0], false);
});
test('a newly observed allowlisted block replaces the old resource type at that location', async t => {
  const f = await fixture(t); await f.store.remember('observation', observation);
  f.at(2000); await f.store.remember('observation', { ...observation, nearbyResources: [block('coal_ore')] });
  assert.equal(f.store.retrieveResources(noScan).length, 1); assert.equal(f.store.retrieveResources(noScan)[0].block, 'coal_ore');
  assert.equal(f.store.retrieveResources(observation)[0].verification, 'historical_recheck_required');
});
test('absence, chunk unloading or an empty bounded scan does not prove resource depletion', async t => {
  const f = await fixture(t); await f.store.remember('observation', observation);
  f.at(2000); await f.store.remember('observation', noScan);
  const recalled = f.store.retrieveResources(noScan)[0];
  assert.equal(recalled.lastObservedAt, 1000); assert.equal(recalled.verification, 'historical_recheck_required');
  assert.equal('depleted' in recalled, false);
});
test('goal results and death snapshots cannot insert resources or turn mining outcomes into depletion facts', async t => {
  const f = await fixture(t);
  await f.store.remember('goal_result', observation, { tool: 'mine', state: 'COMPLETED', resource: block() });
  await f.store.remember('death', observation); assert.equal(f.store.retrieveResources(observation).length, 0);
  await f.store.remember('observation', observation);
  await f.store.remember('goal_result', noScan, { tool: 'mine', state: 'FAILED' });
  assert.equal(f.store.retrieveResources(noScan).length, 1);
  await assert.rejects(f.store.remember('resource_sighting', observation), /memory_record_invalid/);
});
test('resource recall is isolated by world and dimension even for identical coordinates', async t => {
  const f = await fixture(t); await f.store.remember('observation', observation);
  await f.store.remember('observation', { ...observation, dimension: 'the_nether', nearbyResources: [block('coal_ore')] });
  assert.equal(f.store.retrieveResources(observation)[0].block, 'oak_log');
  assert.equal(f.store.retrieveResources({ ...observation, dimension: 'the_nether' })[0].block, 'coal_ore');
  await f.store.close();
  const other = await MemoryStore.open({ ...f.settings, worldId: 'world-b' });
  try {
    assert.equal(other.retrieveResources(observation).length, 0);
    await other.remember('observation', { ...observation, nearbyResources: [block('iron_ore')] });
    assert.equal(other.retrieveResources(observation)[0].block, 'iron_ore');
  } finally { await other.close(); }
  const original = await MemoryStore.open(f.settings);
  try { assert.equal(original.retrieveResources(observation)[0].block, 'oak_log'); }
  finally { await original.close(); }
});
test('invalid names, coordinates, hidden resources and implausible distance claims are discarded', () => {
  const invalid = [block('chest'), block('secret-custom-name'), block('oak_log', 1.5), block('oak_log', 1, 400), block('oak_log', 999), { ...block(), visibility: 'unverified' }, { ...block(), position: { x: 1, y: 64, z: 1, secret: 'text' } }, null];
  for (const item of invalid) assert.deepEqual(resourceSightings({ ...observation, nearbyResources: [item] }), []);
  assert.deepEqual(resourceSightings({ ...observation, position: null }), []);
  assert.deepEqual(resourceSightings({ ...observation, position: { x: Infinity, y: 64, z: 0 } }), []);
});
test('resource capture bounds inspection at sixteen entries and keeps only one sighting per cell', () => {
  const scan = Array(16).fill(block()); scan.push(block('coal_ore', 2));
  assert.equal(resourceSightings({ ...observation, nearbyResources: scan }).length, 1);
  assert.equal(resourceSightings({ ...observation, nearbyResources: [block(), block('coal_ore')] })[0].block, 'coal_ore');
});
test('observed resource input is copied before queued writes and arbitrary item text is excluded', async t => {
  const f = await fixture(t), input = structuredClone(observation);
  input.nearbyResources[0].nbt = { text: 'private-nbt' }; input.nearbyResources[0].owner = 'invented-owner';
  const pending = f.store.remember('observation', input); input.nearbyResources[0].position.x = 9; input.nearbyResources[0].name = 'chest';
  await pending;
  const disk = JSON.stringify(await saved(f));
  assert.equal(disk.includes('private-nbt'), false); assert.equal(disk.includes('invented-owner'), false);
  assert.equal(f.store.retrieveResources(noScan)[0].block, 'oak_log'); assert.equal(f.store.retrieveResources(noScan)[0].position.x, 1);
});
test('recall is copy-isolated, nearest-first, and bounded with validated query parameters', async t => {
  const f = await fixture(t);
  await f.store.remember('observation', { ...observation, nearbyResources: [block('coal_ore', 3), block()] });
  const result = f.store.retrieveResources(noScan, { limit: 1 }); assert.equal(result[0].block, 'oak_log');
  result[0].position.x = 200; assert.equal(f.store.retrieveResources(noScan)[0].position.x, 1);
  for (const limit of [0, 17, 0.5, Infinity]) assert.deepEqual(f.store.retrieveResources(noScan, { limit }), []);
  assert.deepEqual(f.store.retrieveResources({ dimension: null }), []);
  assert.deepEqual(f.store.retrieveResources({ ...noScan, position: { x: NaN, y: 64, z: 0 } }), []);
});
test('old sightings expire from recall and future-dated records do not become falsely fresh', async t => {
  const f = await fixture(t); await f.store.remember('observation', observation);
  f.at(999); assert.equal(f.store.retrieveResources(noScan).length, 0);
  f.at(1000 + RESOURCE_MAX_AGE_MS - 1); assert.equal(f.store.retrieveResources(noScan).length, 1);
  f.at(1000 + RESOURCE_MAX_AGE_MS); assert.equal(f.store.retrieveResources(noScan).length, 0);
  await f.store.remember('observation', observation); assert.equal(f.store.retrieveResources(noScan)[0].ageMs, 0);
});
test('an older queued/clock-shifted sighting cannot overwrite a newer resource observation', async t => {
  const f = await fixture(t); f.at(2000); await f.store.remember('observation', observation);
  f.at(1000); await f.store.remember('observation', { ...observation, nearbyResources: [block('coal_ore')] });
  f.at(2000); assert.equal(f.store.retrieveResources(noScan)[0].block, 'oak_log');
});
test('resource records have a dedicated 128-record cap within the existing total memory budget', async t => {
  const f = await fixture(t);
  for (let batch = 0; batch < 10; batch++) {
    f.at(1000 + batch);
    const nearbyResources = Array.from({ length: 16 }, (_, i) => block('oak_log', batch * 10 + i % 4, 64, Math.floor(i / 4)));
    await f.store.remember('observation', { ...observation, position: { x: batch * 10 + 1.5, y: 64, z: 1.5 }, nearbyResources });
  }
  const disk = await saved(f);
  assert.equal(disk.records.filter(record => record.kind === 'resource_sighting').length, 128);
  assert.ok(disk.records.length <= 500);
  assert.equal(f.store.retrieveResources(noScan).length, 8);
  assert.equal(f.store.retrieveResources(noScan, { limit: 16 }).length, 16);
});
test('concurrent observations serialize with one latest location and all historical events', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 8 }, () => f.store.remember('observation', observation)));
  const disk = await saved(f);
  assert.equal(disk.records.filter(record => record.kind === 'resource_sighting').length, 1);
  assert.equal(disk.records.filter(record => record.kind === 'observation').length, 8);
});
test('schema-v5 event history migrates to v6 before resource sightings are written', async t => {
  const f = await fixture(t); await f.store.remember('spawn', noScan); await f.store.close();
  const legacy = await saved(f); legacy.schemaVersion = 5;
  await writeFile(join(f.directory, 'memory.json'), JSON.stringify(legacy));
  const reopened = await MemoryStore.open(f.settings);
  try {
    assert.equal(reopened.retrieveResources(observation).length, 0);
    await reopened.remember('observation', observation);
    assert.equal((await saved(f)).schemaVersion, 12); assert.equal(reopened.retrieve(observation).length, 2);
  } finally { await reopened.close(); }
});
test('corrupt resource primary recovers the complete previous event/resource snapshot', async t => {
  const f = await fixture(t); await f.store.remember('observation', observation); await f.store.remember('observation', noScan); await f.store.close();
  const bad = await saved(f); bad.records.find(record => record.kind === 'resource_sighting').data.block = 'chest';
  await writeFile(join(f.directory, 'memory.json'), JSON.stringify(bad));
  const reopened = await MemoryStore.open(f.settings);
  try { assert.equal(reopened.recovered, true); assert.equal(reopened.retrieveResources(noScan)[0].block, 'oak_log'); }
  finally { await reopened.close(); }
});
test('duplicate persisted resource locations are rejected instead of reported as multiple deposits', async t => {
  const f = await fixture(t); await f.store.remember('observation', observation); await f.store.remember('observation', noScan); await f.store.close();
  const bad = await saved(f), original = bad.records.find(record => record.kind === 'resource_sighting');
  bad.records.push({ ...original, id: randomUUID() });
  await writeFile(join(f.directory, 'memory.json'), JSON.stringify(bad));
  const reopened = await MemoryStore.open(f.settings);
  try { assert.equal(reopened.recovered, true); assert.equal(reopened.retrieveResources(noScan).length, 1); }
  finally { await reopened.close(); }
});
test('resource sightings falsely labelled as legacy schema trigger recovery, not silent compatibility', async t => {
  const f = await fixture(t); await f.store.remember('observation', observation); await f.store.remember('observation', noScan); await f.store.close();
  const bad = await saved(f); bad.schemaVersion = 5; await writeFile(join(f.directory, 'memory.json'), JSON.stringify(bad));
  const reopened = await MemoryStore.open(f.settings);
  try { assert.equal(reopened.recovered, true); assert.equal(reopened.retrieveResources(noScan).length, 1); }
  finally { await reopened.close(); }
});
test('provider receives bounded separate resource memories, not executable commands or permissions', async t => {
  const f = await fixture(t); let context, executed;
  const controller = new StrategyController({ memory: f.store, toolRegistry: createToolRegistry(), identity: {}, observe: () => observation,
    provider: { plan: async value => { context = value; return { tool: 'scan', args: {}, reason: '' }; } },
    execute: async goal => { executed = goal; return { state: 'COMPLETED' }; }, emit: () => {} });
  controller.start(); await controller.tick();
  assert.equal(context.resourceMemories[0].verification, 'matches_current_observation');
  assert.equal(context.resourceMemories[0].executionRecheckRequired, true);
  assert.equal(context.tools.some(tool => tool.name === 'mine'), false); assert.equal(executed.tool, 'scan');
  assert.equal(context.memories.some(record => record.kind === 'resource_sighting'), false);
});
test('resource memory failures are sanitized and do not prevent safe fallback observation', async () => {
  const events = []; let executed;
  const controller = new StrategyController({ identity: {}, observe: () => observation, emit: event => events.push(event),
    memory: { retrieve: () => [], remember: async () => {}, retrieveResources: () => { throw new Error('private-file-path'); } },
    execute: async goal => { executed = goal; return { state: 'COMPLETED' }; } });
  controller.start(); await controller.tick();
  assert.equal(executed.tool, 'scan'); assert.ok(events.some(event => event.code === 'resource_memory_read_failed'));
  assert.equal(JSON.stringify(events).includes('private-file-path'), false);
});
test('failed resource writes leave the last committed knowledge intact and do not poison later writes', async t => {
  const f = await fixture(t); await f.store.remember('observation', observation);
  const atomicWrite = f.store.atomicWrite.bind(f.store);
  f.store.atomicWrite = async (path, records) => { if (path === f.store.path) throw new Error('private-disk-error'); return atomicWrite(path, records); };
  await assert.rejects(f.store.remember('observation', { ...observation, nearbyResources: [block('coal_ore')] }), /memory_write_failed/);
  assert.equal(f.store.retrieveResources(noScan)[0].block, 'oak_log');
  assert.equal((await saved(f)).records.find(record => record.kind === 'resource_sighting').data.block, 'oak_log');
  f.store.atomicWrite = atomicWrite;
  await f.store.remember('observation', { ...observation, nearbyResources: [block('coal_ore')] });
  assert.equal(f.store.retrieveResources(noScan)[0].block, 'coal_ore');
});
