import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { autonomousWorldPolicy, permitsBlock, permitsPosition, permissionConstraints } from '../src/permissions.js';
import { createToolRegistry } from '../shared/tools/index.js';
import { validateGoal } from '../src/strategy/goals.js';
import { StrategyController } from '../src/strategy/controller.js';
import { observe } from '../src/runtime.js';
const base = { MC_HOST: 'example.org', MC_AUTH: 'offline' };
const autonomous = { ...base, MC_WORLD_ID: 'dedicated-agents', MC_OPERATING_MODE: 'autonomous_world' };
const fields = ['miningPolicy', 'workspacePolicy', 'collectionPolicy', 'navigationPolicy'];
const mutations = ['mine', 'collect_items', 'navigate_local', 'place_crafting_table', 'craft_at_table'];

test('one explicit autonomous-world setting exposes all existing resource/movement mutations without area setup', () => {
  const config = parseConfig(autonomous, 'alice'), registry = createToolRegistry(config);
  assert.equal(config.operatingMode, 'autonomous_world');
  for (const field of fields) { assert.equal(config[field].enabled, true); assert.equal(config[field].scope, 'world'); assert.equal('area' in config[field], false); }
  for (const tool of mutations) {
    const descriptor = registry.catalog().find(entry => entry.name === tool);
    assert.ok(descriptor); assert.equal(descriptor.constraints.scope, 'world'); assert.equal('area' in descriptor.constraints, false);
  }
});
test('upgrading an existing configuration never silently expands its permissions', () => {
  const config = parseConfig(base, 'alice');
  assert.equal(config.operatingMode, 'restricted');
  for (const field of fields) assert.equal(config[field].enabled, false);
  for (const tool of mutations) assert.equal(createToolRegistry(config).catalog().some(entry => entry.name === tool), false);
});
test('autonomous deployment requires a stable world identity and rejects misspelled modes', () => {
  assert.throws(() => parseConfig({ ...base, MC_OPERATING_MODE: 'autonomous_world' }, 'alice'));
  for (const mode of ['autonomous', 'true', 'AUTONOMOUS_WORLD', 'restricted ']) assert.throws(() => parseConfig({ ...autonomous, MC_OPERATING_MODE: mode }, 'alice'));
});
test('restricted mode keeps independent opt-ins, area validation and disabled tools', () => {
  const config = parseConfig({ ...base, MC_OPERATING_MODE: 'restricted', MC_MINING_ENABLED: 'true', MC_MINING_AREA: '0,64,0,5,64,5' }, 'alice');
  assert.equal(config.miningPolicy.enabled, true); assert.equal(config.collectionPolicy.enabled, false);
  assert.equal(permitsBlock(config.miningPolicy, 'overworld', { x: 6, y: 64, z: 1 }), false);
  assert.throws(() => parseConfig({ ...base, MC_MINING_ENABLED: 'true' }, 'alice'));
});
test('legacy per-area settings are explicitly ignored in world mode, not hidden prerequisites', () => {
  const config = parseConfig({ ...autonomous, MC_MINING_ENABLED: 'false', MC_NAVIGATION_AREA: 'old-unused-value', MC_WORKSPACE_DIMENSION: 'the_nether' }, 'alice');
  assert.equal(config.restrictedSettingsIgnored, true);
  for (const field of fields) assert.equal(config[field].enabled, true);
  assert.equal(parseConfig(autonomous, 'alice').restrictedSettingsIgnored, false);
});
test('world mode does not enable paid planning, erase the request budget or require an API request', () => {
  const config = parseConfig(autonomous, 'alice');
  assert.equal(config.aiEnabled, false); assert.equal(config.dailyRequestLimit, 24);
  assert.equal(parseConfig({ ...autonomous, AI_ENABLED: 'true', AI_DAILY_REQUEST_LIMIT: '4' }, 'alice').dailyRequestLimit, 4);
});
test('world-scoped permissions allow all supported dimensions, not unknown/custom dimensions', () => {
  const policy = autonomousWorldPolicy(), point = { x: 12000, y: 70, z: -9000 };
  for (const dimension of ['overworld', 'the_nether', 'the_end']) assert.equal(permitsBlock(policy, dimension, point), true);
  for (const dimension of [undefined, null, '', 'custom_dimension']) assert.equal(permitsPosition(policy, dimension, point), false);
});
test('world authorization preserves finite-coordinate and world-height validation', () => {
  const policy = autonomousWorldPolicy();
  for (const point of [null, { x: NaN, y: 64, z: 0 }, { x: Infinity, y: 64, z: 0 }, { x: 30000001, y: 64, z: 0 }, { x: 0, y: 320, z: 0 }, { x: 0, y: -65, z: 0 }]) assert.equal(permitsPosition(policy, 'overworld', point), false);
  assert.equal(permitsBlock(policy, 'overworld', { x: 0.5, y: 64, z: 0 }), false);
  assert.equal(permitsPosition(policy, 'overworld', { x: 0.5, y: 64.1, z: 0.5 }), true);
});
test('disabled, unknown-scope and malformed policies fail closed', () => {
  const point = { x: 0, y: 64, z: 0 };
  for (const policy of [null, {}, { ...autonomousWorldPolicy(), enabled: false }, { enabled: true, scope: 'world' }, { ...autonomousWorldPolicy(), scope: 'anything' }]) assert.equal(permitsPosition(policy, 'overworld', point), false);
});
test('area bounds retain inclusive block cells and reject continuous coordinates beyond them', () => {
  const policy = { enabled: true, dimension: 'overworld', area: { minX: 0, minY: 64, minZ: 0, maxX: 2, maxY: 64, maxZ: 2 } };
  assert.equal(permitsBlock(policy, 'overworld', { x: 2, y: 64, z: 2 }), true);
  assert.equal(permitsPosition(policy, 'overworld', { x: 2.9, y: 64.9, z: 2.9 }), true);
  assert.equal(permitsPosition(policy, 'overworld', { x: 3, y: 64, z: 2 }), false);
  assert.equal(permitsPosition(policy, 'the_nether', { x: 2, y: 64, z: 2 }), false);
});
test('policies and model-visible constraints are independent copies', () => {
  const config = parseConfig(autonomous, 'alice'), registry = createToolRegistry(config);
  config.miningPolicy.dimensions.length = 0;
  assert.equal(config.collectionPolicy.dimensions.length, 3);
  const descriptor = registry.catalog().find(tool => tool.name === 'mine'); descriptor.constraints.dimensions.length = 0;
  assert.equal(registry.catalog().find(tool => tool.name === 'mine').constraints.dimensions.length, 3);
  const world = autonomousWorldPolicy(), constraints = permissionConstraints(world); constraints.dimensions.length = 0;
  assert.equal(world.dimensions.length, 3);
});
test('model goals cannot select operating modes or override policy arguments', () => {
  for (const extra of [{ scope: 'world' }, { operatingMode: 'autonomous_world' }, { area: null }]) assert.throws(() => validateGoal({ tool: 'navigate_local', args: { x: 1, z: 1, ...extra }, reason: '' }));
});
test('observations expose the trusted operating mode', () => {
  assert.equal(observe({ health: 20, food: 20 }, { operatingMode: 'autonomous_world' }).operatingMode, 'autonomous_world');
  assert.equal(observe({ health: 20, food: 20 }).operatingMode, 'restricted');
});
test('planner selects its own goal from world-scoped capabilities without an approval interaction', async () => {
  const registry = createToolRegistry(parseConfig(autonomous, 'alice'));
  let context, executed;
  const controller = new StrategyController({ toolRegistry: registry, identity: { name: 'Alice' }, emit: () => {},
    observe: () => ({ health: 20, food: 20, operatingMode: 'autonomous_world', dimension: 'overworld', position: { x: 1000.5, y: 64, z: 1000.5 } }),
    provider: { plan: async value => { context = value; return { tool: 'navigate_local', args: { x: 1003, z: 1000 }, reason: 'Explore a nearby known cell.' }; } },
    execute: async goal => { executed = goal; return { state: 'COMPLETED' }; } });
  controller.start(); await controller.tick();
  assert.equal(executed.tool, 'navigate_local'); assert.equal(context.observation.operatingMode, 'autonomous_world');
  assert.equal(context.tools.find(tool => tool.name === 'navigate_local').constraints.scope, 'world');
});
test('unavailable provider still causes read-only fallback, not a hard-coded civilization script', async () => {
  let goal;
  const controller = new StrategyController({ toolRegistry: createToolRegistry(parseConfig(autonomous, 'alice')), identity: {}, emit: () => {},
    observe: () => ({ health: 20, dimension: 'overworld', position: null }), execute: async value => { goal = value; return { state: 'COMPLETED' }; } });
  controller.start(); await controller.tick(); assert.equal(goal.tool, 'scan');
});
