import test from 'node:test';
import assert from 'node:assert/strict';
import { assessNeeds } from '../src/strategy/needs.js';
import { AttemptLedger } from '../src/strategy/attempts.js';
import { StrategyController } from '../src/strategy/controller.js';
import { createToolRegistry } from '../shared/tools/index.js';
import { observe } from '../src/runtime.js';

const base = { health: 20, food: 20, risk: { mode: 'NORMAL' }, inventory: [], inventoryCapacity: { emptyNormalSlots: 36 }, dimension: 'overworld', position: { x: 0.5, y: 64, z: 0.5 } };
const need = (observation, id) => assessNeeds(observation).entries.find(entry => entry.id === id);
const move = { tool: 'move_step', args: { direction: 'north' }, reason: 'Explore.' };
const scan = { tool: 'scan', args: {}, reason: '' };
const minutes = n => n * 60000;
function clockLedger() {
  let time = 0;
  return { ledger: new AttemptLedger({ now: () => time }), at: value => { time = value; } };
}
function planner() {
  let time = 0;
  const executed = [], contexts = [], events = [], observation = structuredClone(base);
  const f = { proposal: move, outcome: { state: 'FAILED' }, observation, executed, contexts, events, at: value => { time = value; } };
  f.controller = new StrategyController({
    now: () => time, intervalMs: minutes(5), identity: {}, observe: () => structuredClone(observation), emit: event => events.push(event),
    provider: { plan: async context => { contexts.push(context); return structuredClone(f.proposal); } },
    execute: async goal => { executed.push(goal); return f.outcome; }
  });
  f.controller.start(); return f;
}

test('needs are bounded advisory evidence, not a list of tools to execute', () => {
  const result = assessNeeds(base);
  assert.equal(result.advisoryOnly, true); assert.equal(result.entries.length, 6);
  assert.equal(need(base, 'food_reserve').score, 60); assert.equal(need(base, 'gathering_tool').score, 25);
  assert.equal(need(base, 'safety').status, 'satisfied');
  assert.equal(result.entries.some(entry => 'tool' in entry || 'args' in entry), false);
});
test('danger and unknown risk sort ahead of supply needs and remain local-reflex owned', () => {
  for (const risk of [{ mode: 'HALT' }, { mode: 'RECOVER' }, { mode: 'ALERT' }, undefined]) {
    const result = assessNeeds({ ...base, risk, food: 0 });
    assert.equal(result.entries[0].id, 'safety'); assert.equal(result.entries[0].score, 100);
    assert.equal(result.entries[0].owner, 'local_reflex');
  }
});
test('falling health and food raise independent local needs without selecting actions', () => {
  const hungry = { ...base, health: 10, food: 4 };
  assert.equal(need(hungry, 'nutrition').score, 80); assert.equal(need(hungry, 'recovery').score, 50);
  assert.equal(need(hungry, 'nutrition').owner, 'local_reflex');
});
test('missing and invalid vitals stay unknown instead of being treated as healthy', () => {
  for (const health of [null, undefined, -1, 21, NaN, Infinity]) {
    assert.equal(need({ ...base, health }, 'recovery').status, 'unknown');
    assert.equal(need({ ...base, health }, 'safety').score, 100);
  }
});
test('food reserve uses the exact local safe-food policy, excluding risky and golden foods', () => {
  for (const name of ['rotten_flesh', 'pufferfish', 'beef', 'suspicious_stew', 'golden_apple']) {
    assert.equal(need({ ...base, inventory: [{ name, count: 64 }] }, 'food_reserve').evidence.safeFoodUnits, 0);
  }
  const observation = { ...base, inventory: [{ name: 'bread', count: 2 }, { name: 'apple', count: 2 }] };
  assert.equal(need(observation, 'food_reserve').score, 0);
});
test('unknown inventory is not reported as an empty food or tool stock', () => {
  for (const inventory of [undefined, null, [{ name: 'bread', count: 999 }], [{ name: 'bread', count: -1 }], Array(47).fill({ name: 'bread', count: 1 })]) {
    assert.equal(need({ ...base, inventory }, 'food_reserve').status, 'unknown');
    assert.equal(need({ ...base, inventory }, 'gathering_tool').status, 'unknown');
  }
  assert.equal(need({ ...base, inventoryKnown: false }, 'food_reserve').status, 'unknown');
});
test('carried pickaxe readiness never claims durability or mining capability', () => {
  const entry = need({ ...base, inventory: [{ name: 'wooden_pickaxe', count: 1 }] }, 'gathering_tool');
  assert.equal(entry.score, 0); assert.equal(entry.evidence.usability, 'not_assessed');
  assert.equal(need({ ...base, inventory: [{ name: 'wooden_axe', count: 1 }] }, 'gathering_tool').score, 25);
});
test('inventory capacity comes from normal slot evidence, not number of item names', () => {
  assert.equal(need({ ...base, inventoryCapacity: { emptyNormalSlots: 0 } }, 'inventory_space').score, 80);
  assert.equal(need({ ...base, inventoryCapacity: { emptyNormalSlots: 2 } }, 'inventory_space').score, 30);
  for (const emptyNormalSlots of [-1, 37, null, 0.5]) assert.equal(need({ ...base, inventoryCapacity: { emptyNormalSlots } }, 'inventory_space').status, 'unknown');
});
test('needs discard arbitrary text and do not mutate the observation', () => {
  const observation = structuredClone(base); observation.inventory = [{ name: 'bread', count: 2, nbt: { text: 'private-custom-name' } }];
  const before = JSON.stringify(observation), result = assessNeeds(observation);
  assert.equal(JSON.stringify(observation), before); assert.equal(JSON.stringify(result).includes('private-custom-name'), false);
});
test('runtime observation exposes needs, deterministic risk and unknown inventory honestly', () => {
  const observation = observe({ health: 20, food: 20 });
  assert.equal(observation.risk.mode, 'NORMAL'); assert.equal(observation.needs.advisoryOnly, true);
  assert.equal(observation.inventoryKnown, false); assert.equal(need(observation, 'food_reserve').status, 'unknown');
});
test('failed attempts cool down for ten minutes, without extending on a lookup', () => {
  const { ledger, at } = clockLedger(); ledger.record(move, base, 'FAILED');
  at(minutes(5)); assert.equal(ledger.remaining(move, base), minutes(5));
  at(minutes(10)); assert.equal(ledger.remaining(move, base), 0);
});
test('repeated failure backoff grows to twenty then thirty minutes with a fixed cap', () => {
  const { ledger, at } = clockLedger(); ledger.record(move, base, 'FAILED');
  at(minutes(10)); ledger.record(move, base, 'BLOCKED'); assert.equal(ledger.remaining(move, base), minutes(20));
  at(minutes(30)); ledger.record(move, base, 'FAILED'); assert.equal(ledger.remaining(move, base), minutes(30));
  at(minutes(60)); ledger.record(move, base, 'FAILED'); assert.equal(ledger.remaining(move, base), minutes(30));
});
test('successful completion clears suppression; cancellation does not create or extend it', () => {
  const { ledger, at } = clockLedger(); ledger.record(move, base, 'CANCELLED'); assert.equal(ledger.remaining(move, base), 0);
  ledger.record(move, base, 'FAILED'); at(minutes(2)); ledger.record(move, base, 'CANCELLED'); assert.equal(ledger.remaining(move, base), minutes(8));
  ledger.record(move, base, 'COMPLETED'); assert.equal(ledger.remaining(move, base), 0);
});
test('read-only observations are never suppressed even after failures', () => {
  const { ledger } = clockLedger();
  for (const tool of ['scan', 'scan_resources', 'craft_options', 'workspace_options', 'scan_items']) {
    const goal = { tool, args: {}, reason: '' }; ledger.record(goal, base, 'FAILED'); assert.equal(ledger.remaining(goal, base), 0);
  }
  assert.equal(ledger.records.size, 0);
});
test('retry identity includes dimension, origin block and exact arguments, not arbitrary reason text', () => {
  const { ledger } = clockLedger(); ledger.record(move, base, 'FAILED');
  assert.equal(ledger.remaining({ ...move, reason: 'Different rationale' }, base), minutes(10));
  assert.equal(ledger.remaining(move, { ...base, position: { x: 0.9, y: 64, z: 0.9 } }), minutes(10));
  assert.equal(ledger.remaining(move, { ...base, dimension: 'the_nether' }), 0);
  assert.equal(ledger.remaining(move, { ...base, position: { x: 1.5, y: 64, z: 0.5 } }), 0);
  assert.equal(ledger.remaining({ ...move, args: { direction: 'south' } }, base), 0);
});
test('argument key order and UUID casing cannot bypass collection retry identity', () => {
  const { ledger } = clockLedger();
  const goal = { tool: 'collect_items', args: { entityId: 1, entityUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', expectedItem: 'oak_log' }, reason: '' };
  ledger.record(goal, base, 'FAILED');
  const reordered = { ...goal, args: { expectedItem: 'oak_log', entityUuid: goal.args.entityUuid.toUpperCase(), entityId: 1 } };
  assert.equal(ledger.remaining(reordered, base), minutes(10));
});
test('ledger copies goals, caps retention and returns at most eight same-dimension records', () => {
  const { ledger, at } = clockLedger();
  for (let i = 0; i < 70; i++) ledger.record(move, { ...base, position: { x: i, y: 64, z: 0 } }, 'FAILED');
  assert.equal(ledger.records.size, 64); assert.equal(ledger.context(base).length, 8);
  assert.equal(ledger.context({ ...base, dimension: 'the_nether' }).length, 0);
  const context = ledger.context(base); context[0].args.direction = 'south'; assert.equal(ledger.context(base)[0].args.direction, 'north');
  at(minutes(60)); assert.equal(ledger.context(base).length, 0); assert.equal(ledger.records.size, 0);
});
test('backwards clocks discard in-memory retry history rather than creating indefinite delays', () => {
  const { ledger, at } = clockLedger(); at(minutes(10)); ledger.record(move, base, 'FAILED');
  at(0); assert.equal(ledger.remaining(move, base), 0);
});
test('planner substitutes a read-only scan for a repeated failed action without another provider request', async () => {
  const f = planner(); await f.controller.tick(); f.at(minutes(5)); await f.controller.tick();
  assert.deepEqual(f.executed.map(goal => goal.tool), ['move_step', 'scan']); assert.equal(f.contexts.length, 2);
  assert.equal(f.contexts[1].deferredAttempts[0].tool, 'move_step');
  assert.equal(f.events.find(event => event.type === 'STRATEGY-DEFER').retryAfterMs, minutes(5));
  f.at(minutes(10)); await f.controller.tick(); assert.equal(f.executed[2].tool, 'move_step');
});
test('cooldown leaves feasible different actions available and preserves exact runtime permissions', async () => {
  const f = planner(); await f.controller.tick(); f.at(minutes(5)); f.proposal = { ...move, args: { direction: 'south' } };
  await f.controller.tick(); assert.equal(f.executed[1].args.direction, 'south');
  const g = planner(); g.controller.toolRegistry = createToolRegistry();
  g.proposal = { tool: 'collect_items', args: { entityId: 1, entityUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', expectedItem: 'oak_log' }, reason: '' };
  await g.controller.tick(); assert.equal(g.executed.length, 0);
});
test('reflex-invalidated execution results stay historical but do not poison the retry ledger', async () => {
  const f = planner();
  f.controller.execute = async () => { f.controller.invalidate(); return { state: 'FAILED' }; };
  await f.controller.tick(); assert.equal(f.controller.attempts.records.size, 0);
});
test('execution exceptions are sanitized and get the same bounded retry protection', async () => {
  const f = planner(); let calls = 0;
  f.controller.execute = async () => { calls++; throw new Error('private-error'); };
  await f.controller.tick(); f.at(minutes(5)); await f.controller.tick();
  assert.equal(calls, 2); assert.ok(f.events.some(event => event.type === 'STRATEGY-DEFER'));
  assert.equal(JSON.stringify(f.events).includes('private-error'), false);
});
test('successful or cancelled goals do not create retry suppression', async () => {
  for (const state of ['COMPLETED', 'CANCELLED']) {
    const f = planner(); f.outcome = { state }; await f.controller.tick(); f.at(minutes(5)); await f.controller.tick();
    assert.deepEqual(f.executed.map(goal => goal.tool), ['move_step', 'move_step']);
  }
});
test('provider receives current needs and no locally invented progression or extra requests', async () => {
  const f = planner(); f.observation.needs = assessNeeds(f.observation); f.proposal = scan;
  await f.controller.tick(); assert.equal(f.contexts.length, 1); assert.deepEqual(f.contexts[0].observation.needs, f.observation.needs);
  assert.equal(f.contexts[0].deferredAttempts.length, 0);
});
