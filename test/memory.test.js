import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from '../src/memory/store.js';
import { StrategyController } from '../src/strategy/controller.js';
import { attachRuntime } from '../src/runtime.js';
import { parseConfig } from '../src/config.js';
const observation = { health: 20, food: 18, dimension: 'overworld', position: { x: 10, y: 64, z: 20 } };
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'arena-memory-'));
  const settings = { directory, agent: 'alice', worldId: 'test-world', ...options };
  const store = await MemoryStore.open(settings);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, settings, store };
}
test('observations and goal outcomes persist across restart with provenance', async t => {
  const f = await fixture(t);
  await f.store.remember('observation', observation);
  await f.store.remember('goal_result', observation, { tool: 'scan', state: 'COMPLETED' });
  await f.store.close();
  const reopened = await MemoryStore.open(f.settings);
  try {
    assert.equal(reopened.size, 2);
    assert.deepEqual(new Set(reopened.retrieve(observation).map(r => r.source)), new Set(['local_observation', 'local_execution']));
  } finally { await reopened.close(); }
});
test('second writer is rejected until first store closes', async t => {
  const f = await fixture(t);
  await assert.rejects(MemoryStore.open(f.settings), /memory_locked/);
  await f.store.close();
  const second = await MemoryStore.open(f.settings); await second.close();
});
test('world and dimension boundaries prevent cross-world recall', async t => {
  const f = await fixture(t);
  await f.store.remember('death', observation);
  await f.store.remember('spawn', { ...observation, dimension: 'the_nether' });
  assert.equal(f.store.retrieve(observation).length, 1);
  assert.equal(f.store.retrieve({ dimension: 'the_nether' }).length, 1);
  assert.equal(f.store.retrieve({ dimension: null }).length, 0);
  await f.store.close();
  const otherWorld = await MemoryStore.open({ ...f.settings, worldId: 'new-world' });
  try { assert.equal(otherWorld.size, 2); assert.equal(otherWorld.retrieve(observation).length, 0); }
  finally { await otherWorld.close(); }
});
test('bounded recall ranks nearby death evidence above routine scans', async t => {
  const f = await fixture(t, { now: () => 10000 });
  await f.store.remember('observation', observation);
  await f.store.remember('death', { ...observation, health: 0 });
  const result = f.store.retrieve({ ...observation, limit: 1 });
  assert.equal(result.length, 1); assert.equal(result[0].kind, 'death');
  result[0].data.health = 19;
  assert.equal(f.store.retrieve({ ...observation, limit: 1 })[0].data.health, 0);
});
test('concurrent writes serialize without losing records and close drains pending writes', async t => {
  const f = await fixture(t);
  const operations = Array.from({ length: 20 }, () => f.store.remember('observation', observation));
  await f.store.close(); await Promise.all(operations);
  const disk = JSON.parse(await readFile(join(f.directory, 'memory.json'), 'utf8'));
  assert.equal(disk.records.length, 20);
  await assert.rejects(f.store.remember('death', observation), /memory_closed/);
});
test('corrupt primary recovers last complete backup and repairs primary', async t => {
  const f = await fixture(t);
  await f.store.remember('spawn', observation);
  await f.store.remember('death', observation);
  await f.store.close();
  await writeFile(join(f.directory, 'memory.json'), '{incomplete');
  const recovered = await MemoryStore.open(f.settings);
  try {
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.size, 1);
    assert.equal(JSON.parse(await readFile(join(f.directory, 'memory.json'), 'utf8')).records[0].kind, 'spawn');
  } finally { await recovered.close(); }
});
test('corrupt primary and backup fail closed without overwriting evidence', async t => {
  const f = await fixture(t); await f.store.close();
  await writeFile(join(f.directory, 'memory.json'), 'bad-main');
  await writeFile(join(f.directory, 'memory.backup.json'), 'bad-backup');
  await assert.rejects(MemoryStore.open(f.settings), /memory_recovery_failed/);
  assert.equal(await readFile(join(f.directory, 'memory.json'), 'utf8'), 'bad-main');
  await assert.rejects(stat(join(f.directory, 'memory.lock')), { code: 'ENOENT' });
});
test('unsupported future schemas do not silently downgrade to backup', async t => {
  const f = await fixture(t);
  await f.store.remember('spawn', observation); await f.store.close();
  await writeFile(join(f.directory, 'memory.json'), JSON.stringify({ schemaVersion: 99, agent: 'alice', records: [] }));
  await assert.rejects(MemoryStore.open(f.settings), /memory_schema_unsupported/);
});
test('wrong agent and oversized memory files are rejected', async t => {
  const f = await fixture(t); await f.store.close();
  await writeFile(join(f.directory, 'memory.json'), JSON.stringify({ schemaVersion: 1, agent: 'bob', records: [] }));
  await assert.rejects(MemoryStore.open(f.settings), /memory_recovery_failed/);
  await writeFile(join(f.directory, 'memory.json'), ' '.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(MemoryStore.open(f.settings), /memory_recovery_failed/);
});
test('stored records cannot include model code, chat or configuration secrets', async t => {
  const f = await fixture(t);
  await f.store.remember('observation', { ...observation, chat: 'private-chat', OPENROUTER_API_KEY: 'secret-key' });
  await f.store.remember('goal_result', observation, { tool: 'scan', state: 'COMPLETED', reason: 'secret-model-text' });
  const raw = await readFile(join(f.directory, 'memory.json'), 'utf8');
  for (const text of ['private-chat', 'secret-key', 'secret-model-text']) assert.equal(raw.includes(text), false);
  await assert.rejects(f.store.remember('goal_result', observation, { tool: 'eval', state: 'COMPLETED' }), /memory_record_invalid/);
  await assert.rejects(f.store.remember('observation', { ...observation, position: { x: Infinity, y: 64, z: 0 } }), /memory_record_invalid/);
});
test('retention caps snapshot at 500 most recent records', async t => {
  const f = await fixture(t);
  const initial = await f.store.remember('observation', observation); await f.store.close();
  const records = Array.from({ length: 500 }, (_, i) => ({ ...initial, id: randomUUID(), at: i }));
  await writeFile(join(f.directory, 'memory.json'), JSON.stringify({ schemaVersion: 1, agent: 'alice', records }));
  const reopened = await MemoryStore.open(f.settings);
  try {
    await reopened.remember('death', { ...observation, health: 0 });
    assert.equal(reopened.size, 500);
    const disk = JSON.parse(await readFile(join(f.directory, 'memory.json'), 'utf8'));
    assert.equal(disk.records[0].at, 1);
    assert.equal(disk.records.at(-1).kind, 'death');
  } finally { await reopened.close(); }
});
test('orphaned lock requires explicit recovery, not unsafe automatic takeover', async t => {
  const f = await fixture(t); await f.store.close();
  await mkdir(join(f.directory, 'memory.lock'));
  await assert.rejects(MemoryStore.open(f.settings), /memory_locked/);
});
test('failed disk write does not update recall and later writes can recover', async t => {
  const f = await fixture(t);
  await f.store.remember('spawn', observation);
  const original = f.store.atomicWrite.bind(f.store);
  f.store.atomicWrite = async () => { throw new Error('private OS path'); };
  await assert.rejects(f.store.remember('death', observation), /memory_write_failed/);
  assert.equal(f.store.size, 1);
  f.store.atomicWrite = original;
  await f.store.remember('death', observation);
  assert.equal(f.store.size, 2);
});
test('restarted planner receives relevant persisted memory but never resumes old commands', async t => {
  const f = await fixture(t);
  await f.store.remember('death', { ...observation, health: 0 });
  await f.store.remember('goal_result', observation, { tool: 'move_step', state: 'CANCELLED' });
  await f.store.close();
  const reopened = await MemoryStore.open(f.settings);
  let prompt; const executed = [];
  const strategy = new StrategyController({ memory: reopened, observe: () => observation, identity: {}, emit: () => {}, provider: { plan: async context => { prompt = context; return { tool: 'scan', args: {}, reason: 'Reassess' }; } }, execute: async goal => { executed.push(goal.tool); return { state: 'COMPLETED' }; } });
  try {
    strategy.start(); await strategy.tick();
    assert.equal(prompt.memories.some(r => r.kind === 'death'), true);
    assert.equal(prompt.memories.some(r => r.data.state === 'CANCELLED'), true);
    assert.deepEqual(executed, ['scan']);
    assert.equal(reopened.size, 4);
  } finally { strategy.stop(); await strategy.settle(); await reopened.close(); }
});
test('memory write failure is sanitized and does not prevent safe fallback', async () => {
  const events = [], goals = [];
  const strategy = new StrategyController({ memory: { retrieve: () => [], remember: async () => { throw new Error('secret-path'); } }, observe: () => observation, identity: {}, emit: e => events.push(e), execute: async goal => { goals.push(goal.tool); return { state: 'COMPLETED' }; } });
  strategy.start(); await strategy.tick();
  assert.deepEqual(goals, ['scan']);
  assert.equal(events.some(e => e.type === 'MEMORY-ERROR'), true);
  assert.equal(JSON.stringify(events).includes('secret-path'), false);
});
test('runtime stores spawn/death without delaying survival and flushes on shutdown', async t => {
  const f = await fixture(t); const bot = new EventEmitter();
  const p = { ...observation.position, distanceTo: () => 0 };
  Object.assign(bot, { entity: { position: p }, health: 20, food: 18, game: { dimension: 'overworld' }, clearControlStates() {}, stopDigging() {}, deactivateItem() {}, quit() { this.emit('end'); } });
  const runtime = attachRuntime(bot, () => {}, { memory: f.store });
  bot.emit('spawn'); bot.health = 0; bot.emit('death');
  assert.equal(runtime.status().ready, false);
  await runtime.close();
  assert.equal(f.store.size, 2);
  assert.equal(f.store.retrieve(observation)[0].kind, 'death');
});
test('world ID can remain stable across server ports and cannot contain paths', () => {
  const env = { MC_HOST: 'example.org', MC_AUTH: 'offline' };
  assert.equal(parseConfig(env, 'alice').worldId, 'example.org:25565');
  assert.equal(parseConfig({ ...env, MC_WORLD_ID: 'world-1', MC_PORT: '33908' }, 'alice').worldId, 'world-1');
  assert.throws(() => parseConfig({ ...env, MC_WORLD_ID: '../world' }, 'alice'));
});
test('interrupted goal result is persisted without scheduling automatic resumption', async t => {
  const f = await fixture(t);
  let finish;
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const strategy = new StrategyController({ memory: f.store, observe: () => observation, identity: {}, emit: () => {}, provider: { plan: async () => ({ tool: 'wait', args: { durationMs: 100 }, reason: '' }) }, execute: () => new Promise(resolve => { finish = resolve; started(); }) });
  strategy.start();
  const pending = strategy.tick(); await began;
  strategy.stop(); finish({ state: 'CANCELLED' });
  await pending; await strategy.settle();
  assert.equal(f.store.retrieve(observation).some(r => r.kind === 'goal_result' && r.data.tool === 'wait' && r.data.state === 'CANCELLED'), true);
  assert.equal(strategy.recent.length, 0);
});
test('lifecycle invalidation during slow observation storage prevents provider request', async () => {
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  let requests = 0;
  const strategy = new StrategyController({ memory: { retrieve: () => [], remember: () => new Promise(resolve => { release = resolve; started(); }) }, observe: () => observation, identity: {}, emit: () => {}, provider: { plan: async () => { requests++; return { tool: 'scan', args: {}, reason: '' }; } }, execute: async () => ({ state: 'COMPLETED' }) });
  strategy.start(); const pending = strategy.tick(); await began;
  strategy.stop(); release(); await pending;
  assert.equal(requests, 0);
});
test('legacy schema-v1 snapshots migrate on write before recording new tool outcomes', async t => {
  const f = await fixture(t);
  await f.store.remember('spawn', observation); await f.store.close();
  const path = join(f.directory, 'memory.json');
  const legacy = JSON.parse(await readFile(path, 'utf8')); legacy.schemaVersion = 1;
  await writeFile(path, JSON.stringify(legacy));
  const reopened = await MemoryStore.open(f.settings);
  try {
    assert.equal(reopened.size, 1);
    await reopened.remember('goal_result', observation, { tool: 'mine', state: 'FAILED' });
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.schemaVersion, 5);
    assert.equal(saved.records.at(-1).data.tool, 'mine');
  } finally { await reopened.close(); }
});
test('resource scan outcomes survive restart as history, not commands', async t => {
  const f = await fixture(t);
  await f.store.remember('goal_result', observation, { tool: 'scan_resources', state: 'COMPLETED' });
  await f.store.close();
  const reopened = await MemoryStore.open(f.settings);
  try { assert.equal(reopened.retrieve(observation)[0].data.tool, 'scan_resources'); }
  finally { await reopened.close(); }
});
test('schema-v2 snapshots migrate to the current schema for crafting history', async t => {
  const f = await fixture(t); await f.store.remember('spawn', observation); await f.store.close();
  const path = join(f.directory, 'memory.json');
  const v2 = JSON.parse(await readFile(path, 'utf8')); v2.schemaVersion = 2;
  await writeFile(path, JSON.stringify(v2));
  const reopened = await MemoryStore.open(f.settings);
  try {
    await reopened.remember('goal_result', observation, { tool: 'craft', state: 'CANCELLED' });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).schemaVersion, 5);
    assert.equal(reopened.retrieve(observation).some(r => r.data.tool === 'craft'), true);
  } finally { await reopened.close(); }
});
test('schema-v3 history migrates before storing workspace outcomes', async t => {
  const f = await fixture(t); await f.store.remember('spawn', observation); await f.store.close();
  const path = join(f.directory, 'memory.json');
  const prior = JSON.parse(await readFile(path, 'utf8')); prior.schemaVersion = 3;
  await writeFile(path, JSON.stringify(prior));
  const reopened = await MemoryStore.open(f.settings);
  try {
    await reopened.remember('goal_result', observation, { tool: 'place_crafting_table', state: 'COMPLETED' });
    await reopened.remember('goal_result', observation, { tool: 'craft_at_table', state: 'CANCELLED' });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).schemaVersion, 5);
    assert.ok(reopened.retrieve(observation).some(record => record.data.tool === 'craft_at_table'));
  } finally { await reopened.close(); }
});
test('schema-v4 snapshots migrate and preserve collection outcomes through restart', async t => {
  const f = await fixture(t); await f.store.remember('spawn', observation); await f.store.close();
  const path = join(f.directory, 'memory.json');
  const prior = JSON.parse(await readFile(path, 'utf8')); prior.schemaVersion = 4;
  await writeFile(path, JSON.stringify(prior));
  const reopened = await MemoryStore.open(f.settings);
  try {
    await reopened.remember('goal_result', observation, { tool: 'scan_items', state: 'COMPLETED' });
    await reopened.remember('goal_result', observation, { tool: 'collect_items', state: 'CANCELLED' });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).schemaVersion, 5);
  } finally { await reopened.close(); }
  const again = await MemoryStore.open(f.settings);
  try { assert.ok(again.retrieve(observation).some(record => record.data.tool === 'collect_items' && record.data.state === 'CANCELLED')); }
  finally { await again.close(); }
});
