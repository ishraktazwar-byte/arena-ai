import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDecision, decisionSteps } from '../src/strategy/plans.js';
import { StrategyController } from '../src/strategy/controller.js';
import { OpenRouterProvider } from '../src/strategy/provider.js';
import { createToolRegistry } from '../shared/tools/index.js';
import { craftFixture } from '../test-support/craft-fixture.js';
const scan = { tool: 'scan', args: {}, reason: '' };
const move = { tool: 'move_step', args: { direction: 'north' }, reason: '' };
const plan = { reason: 'Observe then explore.', steps: [scan, move] };
function latch() { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; }
function fixture() {
  let time = 0;
  const events = [], executed = [], memories = [];
  const observation = { health: 20, food: 20, risk: { mode: 'NORMAL' }, dimension: 'overworld', position: { x: 0.5, y: 64, z: 0.5 } };
  const f = { events, executed, memories, observation, proposal: structuredClone(plan), requests: 0, onExecute: async () => ({ state: 'COMPLETED' }), at: value => { time = value; } };
  f.controller = new StrategyController({ now: () => time, identity: {}, emit: e => events.push(e), observe: () => structuredClone(observation),
    memory: { retrieve: () => [], remember: async (kind, observation, result) => memories.push({ kind, result }) },
    provider: { plan: async () => { f.requests++; return f.proposal; } },
    execute: async goal => { executed.push(goal); return f.onExecute(goal, executed.length); } });
  f.controller.start(); return f;
}
test('single-goal providers remain compatible while plans support one through four typed steps', () => {
  assert.deepEqual(validateDecision(scan), scan); assert.deepEqual(decisionSteps(scan), [scan]);
  for (let length = 1; length <= 4; length++) assert.equal(decisionSteps({ reason: '', steps: Array(length).fill(scan) }).length, length);
});
test('invalid plans reject extra fields, nesting, empty/oversized arrays and malformed reasons', () => {
  for (const value of [null, [], { steps: [], reason: '' }, { steps: Array(5).fill(scan), reason: '' }, { ...plan, repeat: 4 }, { ...plan, reason: 'x'.repeat(241) }, { ...plan, steps: [plan] }, { ...plan, steps: [null] }, { ...plan, steps: 'scan' }]) assert.throws(() => validateDecision(value));
});
test('sparse arrays and invalid later steps cannot pass upfront validation', () => {
  const steps = [scan]; steps.length = 2;
  assert.throws(() => validateDecision({ reason: '', steps }));
  assert.throws(() => validateDecision({ ...plan, steps: [scan, { ...move, args: { direction: 'up' } }] }));
});
test('every step respects the active catalog and cannot inject permissions or executable code', () => {
  assert.throws(() => validateDecision(plan, ['scan']));
  assert.throws(() => validateDecision({ ...plan, steps: [scan, { tool: 'eval', args: {}, reason: '' }] }));
  assert.throws(() => validateDecision({ ...plan, steps: [{ ...move, args: { direction: 'north', scope: 'world' } }] }));
});
test('validated plans copy caller-owned arguments', () => {
  const source = structuredClone(plan), validated = validateDecision(source);
  source.steps[1].args.direction = 'south'; assert.equal(validated.steps[1].args.direction, 'north');
});
test('a successful sequence executes in order using one provider request and records each actual outcome', async () => {
  const f = fixture(); await f.controller.tick();
  assert.deepEqual(f.executed.map(goal => goal.tool), ['scan', 'move_step']); assert.equal(f.requests, 1);
  assert.equal(f.memories.filter(record => record.kind === 'goal_result').length, 2);
  assert.ok(f.events.some(event => event.type === 'STRATEGY-PLAN-COMPLETE'));
});
test('invalid or disabled later steps prevent the entire proposal from starting', async () => {
  const f = fixture(); f.controller.toolRegistry = createToolRegistry();
  f.proposal.steps.push({ tool: 'navigate_local', args: { x: 1, z: 0 }, reason: '' });
  await f.controller.tick(); assert.equal(f.executed.length, 0);
});
test('failed, blocked or cancelled steps discard the tail without an immediate extra provider request', async () => {
  for (const state of ['FAILED', 'BLOCKED', 'CANCELLED']) {
    const f = fixture(); f.onExecute = async () => ({ state }); await f.controller.tick();
    assert.equal(f.executed.length, 1); assert.equal(f.requests, 1); assert.equal(f.memories.filter(r => r.kind === 'goal_result').length, 1);
  }
});
test('execution exceptions stop the plan without exposing raw errors or inventing completed steps', async () => {
  const f = fixture(); f.onExecute = async () => { throw new Error('private-execution-error'); };
  await f.controller.tick(); assert.equal(f.executed.length, 1);
  assert.equal(JSON.stringify(f.events).includes('private-execution-error'), false);
  assert.equal(f.memories.at(-1).result.state, 'FAILED');
});
test('new danger, hunger, missing vitals and dimension changes stop subsequent steps', async () => {
  for (const change of [o => { o.risk.mode = 'ALERT'; }, o => { o.risk = undefined; }, o => { o.food = 5; }, o => { o.health = null; }, o => { o.health = 18; }, o => { o.dimension = 'the_nether'; }]) {
    const f = fixture(); f.onExecute = async () => { change(f.observation); return { state: 'COMPLETED' }; };
    await f.controller.tick(); assert.equal(f.executed.length, 1); assert.ok(f.events.some(e => e.type === 'STRATEGY-PLAN-STOP'));
  }
});
test('expected movement caused by a completed step is not mistaken for provider staleness', async () => {
  const f = fixture(); f.proposal.steps = [move, scan];
  f.onExecute = async () => { f.observation.position.x += 3; return { state: 'COMPLETED' }; };
  await f.controller.tick(); assert.equal(f.executed.length, 2);
});
test('next-step admission stops after sixty seconds or a backwards clock', async () => {
  for (const time of [60000, -1]) {
    const f = fixture(); f.onExecute = async () => { f.at(time); return { state: 'COMPLETED' }; };
    await f.controller.tick(); assert.equal(f.executed.length, 1);
  }
});
test('cooldown substitution performs one scan and discards dependent steps', async () => {
  const f = fixture(); f.proposal.steps = [move, scan]; f.controller.attempts.record(move, f.observation, 'FAILED');
  await f.controller.tick(); assert.deepEqual(f.executed.map(goal => goal.tool), ['scan']);
  assert.ok(f.events.some(e => e.type === 'STRATEGY-PLAN-STOP' && e.reason === 'attempt_cooldown'));
});
test('reflex invalidation during execution discards the tail while keeping the interrupted outcome historical', async () => {
  const f = fixture(); f.onExecute = async () => { f.controller.invalidate(); return { state: 'CANCELLED' }; };
  await f.controller.tick(); assert.equal(f.executed.length, 1); assert.equal(f.memories.at(-1).result.state, 'CANCELLED');
  assert.equal(f.controller.attempts.records.size, 0);
});
test('death and restart do not replay an old tail', async () => {
  const f = fixture(); f.onExecute = async () => { f.controller.stop(); return { state: 'CANCELLED' }; };
  await f.controller.tick(); f.proposal = scan; f.onExecute = async () => ({ state: 'COMPLETED' });
  f.controller.start(); await f.controller.tick(); assert.deepEqual(f.executed.map(goal => goal.tool), ['scan', 'scan']); assert.equal(f.requests, 2);
});
test('no overlapping planning or action execution while a step is pending', async () => {
  const f = fixture(), entered = latch(), done = latch();
  f.onExecute = async () => { entered.resolve(); await done.promise; return { state: 'COMPLETED' }; };
  const pending = f.controller.tick(); await entered.promise; await f.controller.tick();
  assert.equal(f.requests, 1); assert.equal(f.executed.length, 1); done.resolve(); await pending;
});
test('stop during asynchronous history storage prevents the next step', async () => {
  const f = fixture(), entered = latch(), done = latch();
  f.controller.memory.remember = async kind => { if (kind === 'goal_result') { entered.resolve(); await done.promise; } };
  const pending = f.controller.tick(); await entered.promise; f.controller.stop(); done.resolve(); await pending;
  assert.equal(f.executed.length, 1);
});
test('raw plan rationale is not logged or stored as a command', async () => {
  const f = fixture(); f.proposal.reason = 'private-plan-rationale'; f.proposal.steps[0].reason = 'private-step-rationale';
  await f.controller.tick(); const text = JSON.stringify([f.events, f.memories]);
  assert.equal(text.includes('private-plan-rationale'), false); assert.equal(text.includes('private-step-rationale'), false);
});
test('provider accepts bounded plans without increasing token limits or adding requests', async () => {
  let requests = 0, body;
  const provider = new OpenRouterProvider({ apiKey: 'test-only', reserve: async () => true, fetchImpl: async (url, options) => {
    requests++; body = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }));
  } });
  assert.deepEqual(await provider.plan({ tools: [] }), plan); assert.equal(requests, 1); assert.equal(body.max_tokens, 400); assert.equal(body.model, 'openrouter/free');
});
test('malformed provider plans are rejected rather than partially returned', async () => {
  const provider = new OpenRouterProvider({ apiKey: 'test-only', reserve: async () => true, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...plan, steps: Array(5).fill(scan) }) } }] })) });
  await assert.rejects(provider.plan({}), error => error.code === 'invalid_provider_output');
});
test('real guarded crafting steps can consume the verified output of the previous step', async () => {
  const f = craftFixture(), registry = createToolRegistry(), events = [];
  const controller = new StrategyController({ toolRegistry: registry, identity: {}, emit: e => events.push(e),
    observe: () => ({ health: f.bot.health, food: f.bot.food, risk: { mode: 'NORMAL' }, dimension: 'overworld', position: { x: 0.5, y: 64, z: 0.5 }, inventory: f.bot.inventory.items() }),
    provider: { plan: async () => ({ reason: 'Make useful carried supplies.', steps: [{ tool: 'craft', args: { item: 'oak_planks' }, reason: '' }, { tool: 'craft', args: { item: 'stick' }, reason: '' }] }) },
    execute: goal => registry.execute(f.bot, f.arbiter, goal, {}) });
  controller.start(); await controller.tick();
  assert.ok(events.some(event => event.type === 'STRATEGY-PLAN-COMPLETE'));
  assert.equal(f.bot.inventory.items().find(item => item.name === 'stick').count, 4);
});
test('each remaining step revalidates its active tool registration immediately before execution', async () => {
  const f = fixture(); f.controller.toolRegistry = createToolRegistry();
  f.onExecute = async () => { f.controller.toolRegistry.tools.delete('move_step'); return { state: 'COMPLETED' }; };
  await f.controller.tick(); assert.equal(f.executed.length, 1);
});
test('a later craft with unavailable ingredients fails and prevents the remaining tail', async () => {
  const f = craftFixture(), registry = createToolRegistry(), results = [];
  const controller = new StrategyController({ toolRegistry: registry, identity: {}, emit: () => {},
    observe: () => ({ health: 20, food: 20, risk: { mode: 'NORMAL' }, dimension: 'overworld', position: { x: 0.5, y: 64, z: 0.5 } }),
    provider: { plan: async () => ({ reason: '', steps: ['oak_planks', 'stick', 'crafting_table', 'oak_planks'].map(item => ({ tool: 'craft', args: { item }, reason: '' })) }) },
    execute: async goal => { const result = await registry.execute(f.bot, f.arbiter, goal, {}); results.push(result.state); return result; } });
  controller.start(); await controller.tick(); assert.deepEqual(results, ['COMPLETED', 'COMPLETED', 'FAILED']);
});
