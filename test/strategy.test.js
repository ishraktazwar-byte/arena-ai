import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateGoal } from '../src/strategy/goals.js';
import { OpenRouterProvider } from '../src/strategy/provider.js';
import { SharedBudget } from '../src/strategy/budget.js';
import { StrategyController } from '../src/strategy/controller.js';
import { executeGoal } from '../shared/tools/index.js';
import { ControlArbiter } from '../src/control.js';
const scan = { tool: 'scan', args: {}, reason: 'Observe.' };
const envelope = goal => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(goal) } }] }));
const context = { health: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld' };
function fixture(provider) {
  const events = [], executed = [];
  const observation = structuredClone(context);
  const controller = new StrategyController({ provider, identity: { name: 'Alice' }, observe: () => structuredClone(observation), execute: async goal => { executed.push(goal); return { state: 'COMPLETED' }; }, emit: e => events.push(e) });
  controller.start();
  return { controller, events, executed, observation };
}
test('goals accept only known tools and strictly bounded arguments', () => {
  assert.deepEqual(validateGoal(scan), scan);
  assert.throws(() => validateGoal({ ...scan, code: 'process.exit()' }));
  assert.throws(() => validateGoal({ tool: 'eval', args: {}, reason: '' }));
  assert.throws(() => validateGoal({ tool: 'wait', args: { durationMs: 60000 }, reason: '' }));
  assert.throws(() => validateGoal({ tool: 'move_step', args: { direction: 'lava' }, reason: '' }));
  assert.throws(() => validateGoal(JSON.parse('{"tool":"scan","args":{"__proto__":{}},"reason":""}')));
});
test('provider uses only free router and validates output', async () => {
  let request;
  const provider = new OpenRouterProvider({ apiKey: 'test-key-not-real', reserve: async () => true, fetchImpl: async (url, init) => { request = { url, ...init }; return envelope(scan); } });
  assert.deepEqual(await provider.plan({}), scan);
  assert.equal(JSON.parse(request.body).model, 'openrouter/free');
  assert.equal(request.headers.Authorization, 'Bearer test-key-not-real');
});
test('temporary failures retry with fresh budget reservations and bounded backoff', async () => {
  let requests = 0, reservations = 0; const waits = [];
  const provider = new OpenRouterProvider({ apiKey: 'test', reserve: async () => { reservations++; return true; }, wait: async ms => waits.push(ms), fetchImpl: async () => ++requests < 3 ? new Response('', { status: 429, headers: { 'retry-after': '9999' } }) : envelope(scan) });
  assert.deepEqual(await provider.plan({}), scan);
  assert.equal(reservations, 3); assert.deepEqual(waits, [10000, 10000]);
});
test('authentication failures do not retry or expose provider text', async () => {
  let count = 0;
  const provider = new OpenRouterProvider({ apiKey: 'test', reserve: async () => true, fetchImpl: async () => { count++; return new Response('sensitive provider response', { status: 401 }); } });
  await assert.rejects(provider.plan({}), /authentication_failed/);
  assert.equal(count, 1);
});
test('malformed and oversized responses never become actions', async () => {
  for (const fetchImpl of [async () => envelope({ tool: 'eval', args: {}, reason: '' }), async () => new Response('x'.repeat(70000))]) {
    const provider = new OpenRouterProvider({ apiKey: 'test', reserve: async () => true, fetchImpl });
    await assert.rejects(provider.plan({}), /invalid_provider_output/);
  }
});
test('budget refusal and pre-cancelled request make no network call', async () => {
  let called = false;
  const provider = new OpenRouterProvider({ apiKey: 'test', reserve: async () => false, fetchImpl: async () => { called = true; } });
  await assert.rejects(provider.plan({}), /budget_exhausted/);
  await assert.rejects(provider.plan({}, { signal: AbortSignal.abort() }), /cancelled/);
  assert.equal(called, false);
});
test('shared budget persists, caps total requests and fails closed on corruption', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arena-budget-'));
  try {
    const a = new SharedBudget(dir, 2), b = new SharedBudget(dir, 2);
    assert.equal(await a.reserve(), true);
    assert.equal(await b.reserve(), true);
    assert.equal(await a.reserve(), false);
    await writeFile(join(dir, 'request-budget.json'), 'broken');
    assert.equal(await b.reserve(), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('parallel budget reservations cannot exceed limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arena-budget-'));
  try {
    const results = await Promise.all(Array.from({ length: 10 }, () => new SharedBudget(dir, 1).reserve()));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await new SharedBudget(dir, 1).reserve(), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('orphaned budget lock fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arena-budget-'));
  try { await mkdir(join(dir, 'request-budget.lock')); assert.equal(await new SharedBudget(dir).reserve(), false); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
test('no provider uses read-only fallback and respects interval', async () => {
  const f = fixture(null); await f.controller.tick(); await f.controller.tick();
  assert.equal(f.executed.length, 1); assert.equal(f.executed[0].tool, 'scan');
});
test('no overlapping plans; death rejects outstanding result', async () => {
  let finish, calls = 0;
  const f = fixture({ plan: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const pending = f.controller.tick(); await f.controller.tick();
  f.controller.stop(); finish(scan); await pending;
  assert.equal(calls, 1); assert.equal(f.executed.length, 0);
});
test('movement, dimension change, lost health and reflex invalidation reject stale plans', async () => {
  for (const change of [f => { f.observation.position.x = 5; }, f => { f.observation.dimension = 'nether'; }, f => { f.observation.health = 18; }, f => f.controller.invalidate()]) {
    let finish;
    const f = fixture({ plan: () => new Promise(resolve => { finish = resolve; }) });
    const pending = f.controller.tick(); change(f); finish(scan); await pending;
    assert.equal(f.executed.length, 0);
  }
});
test('provider exception is sanitized and fallback remains usable', async () => {
  const f = fixture({ plan: async () => { throw new Error('secret-provider-message'); } });
  await f.controller.tick();
  assert.equal(f.executed[0].tool, 'scan');
  assert.equal(JSON.stringify(f.events).includes('secret-provider-message'), false);
});
test('strategic wait is actually interruptible by survival', async () => {
  const arbiter = new ControlArbiter(() => {});
  const pending = executeGoal({}, arbiter, { tool: 'wait', args: { durationMs: 5000 }, reason: '' }, { observe: () => ({}) });
  arbiter.setSafetyFloor(1000, 'creeper');
  assert.equal((await pending).state, 'CANCELLED');
});
test('bounded network retries cannot loop forever', async () => {
  let calls = 0;
  const provider = new OpenRouterProvider({ apiKey: 'test', reserve: async () => true, wait: async () => {}, fetchImpl: async () => { calls++; throw new Error('network failure'); } });
  await assert.rejects(provider.plan({}), /network_or_timeout/);
  assert.equal(calls, 3);
});
test('budget resets next UTC day, but not on a backward clock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arena-budget-'));
  let clock = Date.parse('2026-09-12T12:00:00Z');
  try {
    const budget = new SharedBudget(dir, 1, () => clock);
    assert.equal(await budget.reserve(), true);
    clock -= 86400000; assert.equal(await budget.reserve(), false);
    clock += 2 * 86400000; assert.equal(await budget.reserve(), true);
    assert.equal(await budget.reserve(), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
