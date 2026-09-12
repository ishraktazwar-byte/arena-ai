import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as settle } from 'node:timers/promises';
import { createToolRegistry, executeGoal, ToolRegistry } from '../shared/tools/index.js';
import { scanResources } from '../shared/tools/resources.js';
import { checkMining, chooseMiningTool, mineBlock } from '../shared/tools/mine.js';
import { ControlArbiter } from '../src/control.js';
import { parseConfig } from '../src/config.js';
import { StrategyController } from '../src/strategy/controller.js';
import { validateGoal } from '../src/strategy/goals.js';
const policy = { enabled: true, dimension: 'overworld', area: { minX: -10, minY: 64, minZ: -10, maxX: 10, maxY: 65, maxZ: 10 } };
const args = { x: 2, y: 64, z: 0, expectedBlock: 'stone' };
function vec(x, y, z) { return { x, y, z, offset(dx, dy, dz) { return vec(x + dx, y + dy, z + dz); }, distanceTo(p) { return Math.hypot(x - p.x, y - p.y, z - p.z); } }; }
function fixture() {
  const cells = new Map(), calls = [];
  const tool = { name: 'iron_pickaxe', type: 101, count: 1, durabilityUsed: 0 };
  const items = [tool];
  function make(name, x, y, z) {
    return { name, type: name === 'air' ? 0 : 1, stateId: name === 'air' ? 0 : 1, position: vec(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block', shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]], diggable: name !== 'air', getProperties: () => ({}), canHarvest: type => name.endsWith('_log') || type === 101 };
  }
  const bot = {
    entity: { position: vec(0.5, 64, 0.5), onGround: true }, entities: {}, health: 20, food: 20, oxygenLevel: 20,
    game: { dimension: 'overworld' }, inventory: { items: () => items }, heldItem: tool,
    registry: { blocksByStateId: { 0: { name: 'air' }, 1: { name: 'stone' } }, itemsByName: { iron_pickaxe: { maxDurability: 250 } } },
    _client: new EventEmitter(),
    blockAt: p => cells.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || make(Math.floor(p.y) < 64 ? 'stone' : 'air', Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    canDigBlock: () => true, digTime: () => 100,
    equip: async item => { calls.push('equip'); bot.heldItem = item; }, unequip: async () => { bot.heldItem = null; },
    lookAt: async () => { calls.push('look'); }, stopDigging: () => { calls.push('stop'); }
  };
  const put = (name, x = 2, y = 64, z = 0) => { const block = make(name, x, y, z); cells.set(`${x},${y},${z}`, block); return block; };
  put('stone');
  bot.dig = async (block, forceLook) => {
    calls.push(['dig', forceLook]);
    put('air', block.position.x, block.position.y, block.position.z);
    bot._client.emit('block_change', { location: block.position, type: 0 });
  };
  const arbiter = new ControlArbiter(() => bot.stopDigging());
  const mine = (options = {}) => arbiter.run('strategy', 100, session => mineBlock(bot, args, policy, session, { confirmationMs: 15, ...options }), 500);
  return { bot, calls, items, tool, put, arbiter, mine };
}
test('catalog derives from registered tools and mining is opt-in', () => {
  const registry = createToolRegistry();
  assert.equal(registry.catalog().some(t => t.name === 'scan_resources'), true);
  assert.equal(registry.catalog().some(t => t.name === 'mine'), false);
  assert.throws(() => registry.validate({ tool: 'mine', args, reason: '' }));
  const enabled = createToolRegistry({ miningPolicy: policy });
  assert.equal(enabled.catalog().some(t => t.name === 'mine'), true);
  const catalog = enabled.catalog(); catalog[0].description = 'mutated';
  assert.notEqual(enabled.catalog()[0].description, 'mutated');
  assert.throws(() => new ToolRegistry().register('eval', { run() {} }));
});
test('mining goals reject oversized, fractional and extra arguments', () => {
  assert.equal(validateGoal({ tool: 'mine', args, reason: '' }).tool, 'mine');
  for (const extra of [{ x: 0.5 }, { y: -100 }, { z: 30000001 }, { code: 'eval()' }]) assert.throws(() => validateGoal({ tool: 'mine', args: { ...args, ...extra }, reason: '' }));
});
test('resource scan is bounded and excludes occluded and unknown blocks', () => {
  const f = fixture(); f.put('diamond_ore', 3, 64, 0);
  const result = scanResources(f.bot);
  assert.ok(result.length <= 16);
  assert.equal(result.some(r => r.position.x === 2 && r.position.y === 64), true);
  assert.equal(result.some(r => r.name === 'diamond_ore'), false);
  f.bot.blockAt = () => null;
  assert.deepEqual(scanResources(f.bot), []);
});
test('scan_resources is read-only and does not preempt combat', async () => {
  const f = fixture(); const active = f.arbiter.run('combat', 500, () => new Promise(() => {}));
  const result = await executeGoal(f.bot, f.arbiter, { tool: 'scan_resources', args: {}, reason: '' }, { observe: () => ({}) });
  assert.equal(result.state, 'COMPLETED');
  assert.equal(f.arbiter.current.owner, 'combat');
  assert.equal(f.calls.some(c => Array.isArray(c)), false);
  f.arbiter.cancel(); await active;
});
test('mining rejects disabled permission, wrong region and wrong dimension', () => {
  const f = fixture();
  assert.throws(() => checkMining(f.bot, args, { enabled: false }), /outside_mining_permission/);
  assert.throws(() => checkMining(f.bot, { ...args, x: 11 }, policy), /outside_mining_permission/);
  f.bot.game.dimension = 'the_nether';
  assert.throws(() => checkMining(f.bot, args, policy), /outside_mining_permission/);
});
test('mining refuses support removal and above-head digging', () => {
  const f = fixture(); const broad = { ...policy, area: { ...policy.area, minY: 60, maxY: 70 } };
  assert.throws(() => checkMining(f.bot, { ...args, y: 63 }, broad), /vertical_dig_forbidden/);
  assert.throws(() => checkMining(f.bot, { ...args, y: 66 }, broad), /vertical_dig_forbidden/);
  assert.throws(() => checkMining(f.bot, { ...args, x: 0 }, broad), /body_column_forbidden/);
});
test('danger, weak vitals, airborne body and unknown footing prohibit mining', () => {
  for (const modify of [f => { f.bot.health = 8; }, f => { f.bot.food = 10; }, f => { f.bot.entity.onGround = false; }, f => { f.bot.entities[1] = { name: 'zombie', position: vec(2, 64, 0) }; }, f => { f.bot.blockAt = () => null; }]) {
    const f = fixture(); modify(f); assert.throws(() => checkMining(f.bot, args, policy), /unsafe_/);
  }
});
test('fluids, waterlogged neighbors, gravity blocks and unknown neighbors prohibit mining', () => {
  for (const modify of [f => f.put('lava', 3, 64, 0), f => f.put('sand', 2, 65, 0), f => { f.put('oak_log', 3, 64, 0).getProperties = () => ({ waterlogged: true }); }, f => { const original = f.bot.blockAt; f.bot.blockAt = p => Math.floor(p.x) === 3 ? null : original(p); }]) {
    const f = fixture(); modify(f); assert.throws(() => checkMining(f.bot, args, policy), /unsafe_neighbor/);
  }
});
test('unlisted blocks, stale resource names and blocked line-of-sight are refused', () => {
  const f = fixture(); f.put('chest');
  assert.throws(() => checkMining(f.bot, { ...args, expectedBlock: 'chest' }, policy), /unsupported_block/);
  assert.throws(() => checkMining(f.bot, args, policy), /stale_block/);
  f.put('stone'); f.put('stone', 1, 65, 0);
  assert.throws(() => checkMining(f.bot, args, policy), /blocked_or_hazardous_target/);
});
test('tool selection checks harvest compatibility and avoids near-broken tools', () => {
  const f = fixture(); const block = checkMining(f.bot, args, policy);
  assert.equal(chooseMiningTool(f.bot, block).type, 101);
  f.tool.durabilityUsed = 249;
  assert.throws(() => chooseMiningTool(f.bot, block), /missing_harvest_tool/);
  assert.equal(chooseMiningTool(f.bot, f.put('oak_log')), null);
});
test('successful mining requires server evidence and does not claim collected drops', async () => {
  const f = fixture(); const result = await f.mine();
  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.result.serverObservedAir, true);
  assert.deepEqual(result.result.inventoryGainsObserved, []);
  assert.equal(result.result.dropsCollected, 'not_guaranteed');
  assert.deepEqual(f.calls.find(Array.isArray), ['dig', 'ignore']);
  assert.equal(f.bot._client.listenerCount('block_change'), 0);
});
test('optimistic local air alone is not accepted as server confirmation', async () => {
  const f = fixture(); f.bot.dig = async () => { f.put('air'); };
  assert.equal((await f.mine()).state, 'FAILED');
  assert.equal(f.bot._client.listenerCount('block_change'), 0);
});
test('unrelated block-change packet does not confirm requested block', async () => {
  const f = fixture(); f.bot.dig = async () => { f.put('air'); f.bot._client.emit('block_change', { location: { x: 9, y: 64, z: 0 }, type: 0 }); };
  assert.equal((await f.mine()).state, 'FAILED');
});
test('changed geometry while aiming prevents any dig command', async () => {
  const f = fixture(); let finish;
  f.bot.lookAt = () => new Promise(resolve => { finish = resolve; });
  const pending = f.mine(); await settle();
  f.put('lava', 3, 64, 0); finish();
  assert.equal((await pending).state, 'FAILED');
  assert.equal(f.calls.some(Array.isArray), false);
});
test('cancellation during equipment swap prevents late dig start', async () => {
  const f = fixture(); let finish;
  f.bot.heldItem = null; f.bot.equip = () => new Promise(resolve => { finish = resolve; });
  const pending = f.mine(); await settle(); f.arbiter.cancel('death'); finish(); await settle();
  assert.equal((await pending).state, 'CANCELLED'); assert.equal(f.calls.some(Array.isArray), false);
});
test('emergency preemption stops active digging and cleans its packet listener', async () => {
  const f = fixture(); let rejectDig;
  f.bot.dig = () => new Promise((_, reject) => { rejectDig = reject; });
  f.bot.stopDigging = () => { rejectDig?.(new Error('aborted')); };
  const pending = f.mine(); await settle();
  const reflex = f.arbiter.run('reflex', 1000, async () => {});
  assert.equal((await pending).state, 'CANCELLED'); await reflex; await settle();
  assert.equal(f.bot._client.listenerCount('block_change'), 0);
});
test('mid-dig environmental changes abort uncooperative dig tasks', async () => {
  const f = fixture(); f.bot.dig = () => new Promise(() => {});
  const pending = f.mine(); await settle(); f.put('gravel', 2, 65, 0);
  assert.equal((await pending).state, 'FAILED');
  assert.equal(f.bot._client.listenerCount('block_change'), 0);
});
test('registry permission is an immutable snapshot and reports safe mining error codes', async () => {
  const f = fixture(); const original = structuredClone(policy);
  const registry = createToolRegistry({ miningPolicy: original }); original.area.maxX = 1;
  assert.equal((await registry.execute(f.bot, f.arbiter, { tool: 'mine', args, reason: '' }, {})).state, 'COMPLETED');
  const result = await registry.execute(f.bot, f.arbiter, { tool: 'mine', args: { ...args, x: 12 }, reason: '' }, {});
  assert.equal(result.reason, 'outside_mining_permission');
});
test('disabled mine cannot be enabled by a provider response', async () => {
  let called = false, prompt;
  const registry = createToolRegistry();
  const strategy = new StrategyController({ toolRegistry: registry, identity: {}, observe: () => ({ health: 20, dimension: 'overworld', position: null }), emit: () => {}, provider: { plan: async context => { prompt = context; return { tool: 'mine', args, reason: '' }; } }, execute: async () => { called = true; } });
  strategy.start(); await strategy.tick();
  assert.equal(prompt.tools.some(t => t.name === 'mine'), false); assert.equal(called, false);
});
test('config requires explicit bounded mining permission', () => {
  const env = { MC_HOST: 'example.org', MC_AUTH: 'offline' };
  assert.equal(parseConfig(env, 'alice').miningPolicy.enabled, false);
  for (const area of ['', '1,2,3', '0,64,0,-1,65,1', '0,-70,0,1,65,1', '0,64,0,1.5,65,1']) assert.throws(() => parseConfig({ ...env, MC_MINING_ENABLED: 'true', MC_MINING_AREA: area }, 'alice'));
  assert.equal(parseConfig({ ...env, MC_MINING_ENABLED: 'true', MC_MINING_AREA: '-10,64,-10,10,65,10' }, 'alice').miningPolicy.area.maxX, 10);
});
test('a removed block with observed inventory increase reports only the observed delta', async () => {
  const f = fixture(); const dig = f.bot.dig;
  f.bot.dig = async (...params) => { await dig(...params); f.items.push({ name: 'cobblestone', count: 1, type: 3 }); };
  const result = await f.mine();
  assert.deepEqual(result.result.inventoryGainsObserved, [{ name: 'cobblestone', count: 1 }]);
});
test('changed block state after equipment selection prevents stale dig', async () => {
  const f = fixture(); let finish;
  f.bot.lookAt = () => new Promise(resolve => { finish = resolve; });
  const pending = f.mine(); await settle(); f.put('stone').stateId = 99; finish();
  assert.equal((await pending).state, 'FAILED');
  assert.equal(f.calls.some(Array.isArray), false);
});
test('late aim completion after death cannot start a new dig', async () => {
  const f = fixture(); let finish;
  f.bot.lookAt = () => new Promise(resolve => { finish = resolve; });
  const pending = f.mine(); await settle(); f.arbiter.cancel('death'); finish(); await settle();
  assert.equal((await pending).state, 'CANCELLED');
  assert.equal(f.calls.some(Array.isArray), false);
});
test('client cache update plus a server non-air packet still does not confirm removal', async () => {
  const f = fixture(); f.bot.dig = async block => { f.put('air'); f.bot._client.emit('block_change', { location: block.position, type: 1 }); };
  assert.equal((await f.mine()).state, 'FAILED');
});
