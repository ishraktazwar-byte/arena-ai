import { autonomousWorldPolicy } from '../src/permissions.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as settle } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { ControlArbiter } from '../src/control.js';
import { inspectWorkspaces, checkPlacement, checkTable, placeTable, craftAtTable, sendTopInteraction } from '../shared/tools/workspace.js';
import { createToolRegistry } from '../shared/tools/index.js';
import { parseConfig } from '../src/config.js';
import { validateGoal } from '../src/strategy/goals.js';
import { craftFixture, vec } from '../test-support/craft-fixture.js';
const policy = { enabled: true, dimension: 'overworld', area: { minX: -5, minY: 64, minZ: -5, maxX: 5, maxY: 64, maxZ: 5 } };
const point = { x: 2, y: 64, z: 0 };
const craftArgs = { ...point, item: 'wooden_pickaxe' };
function latch() { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; }
function world() {
  const cells = new Map();
  const block = (name, x, y, z) => ({ name, type: name === 'air' ? 0 : 1, stateId: name === 'crafting_table' ? 2 : name === 'air' ? 0 : 1, position: vec(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block', shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  return {
    put(name, x = 2, y = 64, z = 0) { const b = block(name, x, y, z); cells.set(`${x},${y},${z}`, b); return b; },
    blockAt(p) { const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z); return cells.get(`${x},${y},${z}`) || block(y < 64 ? 'stone' : 'air', x, y, z); }
  };
}
function fixture(t) {
  const w = world(), bot = new EventEmitter(), client = new EventEmitter(), calls = [], events = [];
  client.state = 'play';
  const item = { type: 10, name: 'crafting_table', count: 2, slot: 36 };
  const window = { id: 4, type: 'minecraft:crafting', slots: Array(46).fill(null), selectedItem: null, inventoryStart: 10, inventoryEnd: 46 };
  Object.assign(bot, { version: '1.21.1', QUICK_BAR_START: 36, health: 20, food: 20, oxygenLevel: 20, entity: { position: vec(0.5, 64, 0.5), onGround: true }, entities: {}, game: { dimension: 'overworld' }, currentWindow: null,
    inventory: { slots: Array(46).fill(null), selectedItem: null, items: () => [item] }, heldItem: item, registry: { blocksByStateId: { 0: { name: 'air' }, 1: { name: 'stone' }, 2: { name: 'crafting_table' } } }, _client: client, blockAt: w.blockAt,
    equip: async it => { calls.push(['equip']); bot.heldItem = it; }, unequip: async () => { calls.push(['unequip']); bot.heldItem = null; }, lookAt: async () => { calls.push(['look']); },
    closeWindow: async win => { calls.push(['close', win.id]); bot.currentWindow = null; }
  });
  bot.inventory.slots[36] = item;
  bot.setQuickBarSlot = index => { calls.push(['held_slot', index]); bot.heldItem = bot.inventory.slots[36 + index] || null; };
  bot._syncWindow = async () => client.emit('window_items', { windowId: 0, items: bot.inventory.slots });
  bot.clickWindow = async (slot, hotbar, mode) => { calls.push(['click', slot, hotbar, mode]); const stack = bot.inventory.slots[slot]; bot.inventory.slots[36 + hotbar] = stack; if (stack) stack.slot = 36 + hotbar; bot.inventory.slots[slot] = null; };
  function open() { client.emit('open_window', { windowId: window.id }); bot.currentWindow = window; bot.emit('windowOpen', window); }
  client.write = (name, packet) => {
    calls.push([name, packet]);
    if (bot.heldItem?.name === 'crafting_table') {
      w.put('crafting_table'); item.count--;
      client.emit('block_change', { location: point, type: 2 });
    } else open();
  };
  const arbiter = new ControlArbiter(() => calls.push(['stop']));
  const craft = async () => { calls.push(['craft']); return { item: 'wooden_pickaxe', serverInventoryVerified: true }; };
  const runPlace = opts => arbiter.run('strategy', 100, s => placeTable(bot, point, policy, s, { responseTimeoutMs: 2500, ...opts }), 5000);
  const runCraft = opts => arbiter.run('strategy', 100, s => craftAtTable(bot, craftArgs, policy, s, { arbiter, emit: e => events.push(e), responseTimeoutMs: 2500, craft, ...opts }), 5000);
  t.after(() => { arbiter.cancel('test_end'); bot.emit('end'); });
  return { bot, client, calls, events, item, window, arbiter, ...w, open, runPlace, runCraft };
}
test('workspace catalog is opt-in and advertises independent immutable bounds', async t => {
  const f = fixture(t), disabled = createToolRegistry(), p = structuredClone(policy);
  assert.equal(disabled.catalog().some(tool => tool.name === 'workspace_options'), true);
  assert.equal(disabled.catalog().some(tool => tool.name === 'place_crafting_table'), false);
  assert.throws(() => disabled.validate({ tool: 'craft_at_table', args: craftArgs, reason: '' }));
  const registry = createToolRegistry({ workspacePolicy: p }); p.area.maxX = 1;
  assert.equal(registry.catalog().find(tool => tool.name === 'place_crafting_table').constraints.area.maxX, 5);
  const result = await registry.execute(f.bot, f.arbiter, { tool: 'place_crafting_table', args: point, reason: '' }, {});
  assert.equal(result.state, 'COMPLETED');
});
test('workspace schemas reject arbitrary blocks, recipes and out-of-range coordinates', () => {
  assert.equal(validateGoal({ tool: 'craft_at_table', args: craftArgs, reason: '' }).tool, 'craft_at_table');
  for (const args of [{ ...point, block: 'tnt' }, { ...point, y: 400 }, { ...point, x: 1.5 }]) assert.throws(() => validateGoal({ tool: 'place_crafting_table', args, reason: '' }));
  assert.throws(() => validateGoal({ tool: 'craft_at_table', args: { ...point, item: 'tnt' }, reason: '' }));
});
test('read-only workspace inspection is bounded and includes visible approved tables', t => {
  const f = fixture(t); f.put('crafting_table');
  const result = inspectWorkspaces(f.bot, policy);
  assert.ok(result.tables.some(table => table.approved && table.position.x === 2));
  assert.ok(result.tables.length <= 8 && result.placementSites.length <= 8);
  assert.equal(f.calls.length, 0);
  assert.equal(inspectWorkspaces(f.bot).placementSites.length, 0);
});
test('placement requires approved dimension, supported elevation and inert full ground', t => {
  const f = fixture(t);
  assert.throws(() => checkPlacement(f.bot, point, { enabled: false }), /outside_workspace_permission/);
  f.bot.game.dimension = 'the_nether'; assert.throws(() => checkPlacement(f.bot, point, policy), /outside_workspace_permission/); f.bot.game.dimension = 'overworld';
  f.put('chest', 2, 63, 0); assert.throws(() => checkPlacement(f.bot, point, policy), /support_unsafe/);
  f.put('stone', 2, 63, 0).shapes = [[0, 0, 0, 1, 0.5, 1]]; assert.throws(() => checkPlacement(f.bot, point, policy), /support_unsafe/);
});
test('placement rejects occupied cells, overhead blocks, body overlap and other entities', t => {
  const f = fixture(t);
  f.put('dirt'); assert.throws(() => checkPlacement(f.bot, point, policy), /destination_occupied/); f.put('air');
  f.put('stone', 2, 65, 0); assert.throws(() => checkPlacement(f.bot, point, policy), /destination_occupied/); f.put('air', 2, 65, 0);
  assert.throws(() => checkPlacement(f.bot, { ...point, x: 0 }, policy), /body_overlap/);
  f.bot.entities[1] = { name: 'player', position: vec(2.5, 64, 0.5), width: 0.6, height: 1.8 };
  assert.throws(() => checkPlacement(f.bot, point, policy), /entity_overlap/);
});
test('placement rejects dangerous bodies, unknown terrain and occluded faces', t => {
  const f = fixture(t); f.bot.health = 4;
  assert.throws(() => checkPlacement(f.bot, point, policy), /unsafe_workspace_body/); f.bot.health = 20;
  f.put('stone', 1, 64, 0); f.put('stone', 1, 65, 0);
  assert.throws(() => checkPlacement(f.bot, point, policy), /support_not_visible/);
  f.bot.blockAt = () => null; assert.throws(() => checkPlacement(f.bot, point, policy), /unsafe_workspace_body/);
});
test('a placement that removes the only known flat exit is rejected', t => {
  const f = fixture(t);
  for (const [x, z] of [[-1, 0], [0, 1], [0, -1]]) f.put('stone', x, 64, z);
  assert.throws(() => checkPlacement(f.bot, { x: 1, y: 64, z: 0 }, policy), /blocks_known_exit/);
});
test('one placement requires server block evidence and reports observed item counts', async t => {
  const f = fixture(t); const result = await f.runPlace();
  assert.equal(result.state, 'COMPLETED'); assert.equal(result.result.serverTableObserved, true);
  assert.equal(result.result.tableItemsBefore, 2); assert.equal(result.result.tableItemsAfter, 1);
  assert.equal(f.calls.filter(call => call[0] === 'block_place').length, 1);
  assert.equal(f.client.listenerCount('block_change'), 0);
});
test('no held table item causes no interaction', async t => {
  const f = fixture(t); f.item.count = 0;
  assert.equal((await f.runPlace()).state, 'FAILED');
  assert.equal(f.calls.some(call => call[0] === 'block_place'), false);
});
test('predicted local placement and unrelated server packets are not confirmation', async t => {
  const f = fixture(t); f.client.write = () => { f.put('crafting_table'); f.client.emit('block_change', { location: { ...point, x: 3 }, type: 2 }); };
  assert.equal((await f.runPlace({ responseTimeoutMs: 20 })).state, 'FAILED'); assert.equal(f.client.listenerCount('block_change'), 0);
});
test('cancellation during staging or aim prevents a late placement packet', async t => {
  for (const method of ['clickWindow', 'lookAt']) {
    const f = fixture(t); let finish; const entered = latch();
    if (method === 'clickWindow') { f.bot.heldItem = null; f.item.slot = 9; f.bot.inventory.slots[9] = f.item; f.bot.inventory.slots[36] = null; }
    f.bot[method] = () => new Promise(resolve => { finish = resolve; entered.resolve(); });
    const pending = f.runPlace(); await entered.promise; f.arbiter.cancel('death'); finish(); await settle();
    assert.equal((await pending).state, 'CANCELLED'); assert.equal(f.calls.some(c => c[0] === 'block_place'), false);
  }
});
test('geometry changes during aim prevent placement', async t => {
  const f = fixture(t); let finish; const entered = latch(); f.bot.lookAt = () => new Promise(resolve => { finish = resolve; entered.resolve(); });
  const pending = f.runPlace(); await entered.promise; f.put('stone'); finish();
  assert.equal((await pending).state, 'FAILED'); assert.equal(f.calls.some(c => c[0] === 'block_place'), false);
});
test('opening uses empty hand, a server-backed window, and a single owned close', async t => {
  const f = fixture(t); f.put('crafting_table'); const result = await f.runCraft();
  assert.equal(result.state, 'COMPLETED'); assert.equal(f.bot.heldItem, null);
  assert.equal(f.calls.filter(c => c[0] === 'craft').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'close').length, 1);
  assert.equal(f.bot.currentWindow, null);
});
test('table removal during aiming prevents interaction', async t => {
  const f = fixture(t); f.put('crafting_table'); let finish; const entered = latch();
  f.bot.lookAt = () => new Promise(resolve => { finish = resolve; entered.resolve(); });
  const pending = f.runCraft(); await entered.promise; f.put('air'); finish();
  assert.equal((await pending).state, 'FAILED'); assert.equal(f.calls.some(c => c[0] === 'block_place'), false);
});
test('cancellation before opening request does not quarantine future safe work', async t => {
  const f = fixture(t); f.put('crafting_table'); let finish; const entered = latch();
  f.bot.lookAt = () => new Promise(resolve => { finish = resolve; entered.resolve(); });
  const pending = f.runCraft(); await entered.promise; f.arbiter.cancel('creeper'); finish(); await settle();
  assert.equal((await pending).state, 'CANCELLED'); assert.equal(inspectWorkspaces(f.bot, policy).reconnectRequired, false);
});
test('unconfirmed opening times out and refuses retry until reconnect', async t => {
  const f = fixture(t); f.put('crafting_table'); f.client.write = () => {};
  assert.equal((await f.runCraft({ responseTimeoutMs: 20 })).state, 'FAILED');
  assert.equal(inspectWorkspaces(f.bot, policy).reconnectRequired, true);
  assert.equal((await f.runCraft({ responseTimeoutMs: 20 })).state, 'FAILED'); assert.equal(f.calls.some(c => c[0] === 'craft'), false);
});
test('late window after cancellation is closed by a new safety action, not old strategy', async t => {
  const f = fixture(t); const sent = latch(); f.put('crafting_table'); f.client.write = () => { sent.resolve(); };
  const pending = f.runCraft({ responseTimeoutMs: 500 }); await sent.promise;
  const escape = f.arbiter.run('escape', 1000, () => new Promise(() => {}));
  assert.equal((await pending).state, 'CANCELLED');
  f.open(); await settle();
  assert.equal((await escape).state, 'CANCELLED');
  assert.equal(f.bot.currentWindow, null); assert.equal(f.calls.some(c => c[0] === 'craft'), false);
  assert.ok(f.events.some(e => e.type === 'WORKSPACE-WINDOW-SAFETY' && e.state === 'COMPLETED'));
});
test('local window event without a matching server open packet cannot start crafting', async t => {
  const f = fixture(t); f.put('crafting_table');
  f.client.write = () => { f.bot.currentWindow = f.window; f.bot.emit('windowOpen', f.window); };
  assert.equal((await f.runCraft()).state, 'FAILED'); await settle();
  assert.equal(f.calls.some(c => c[0] === 'craft'), false); assert.equal(f.bot.currentWindow, null);
});
test('buffered inventory window event before raw packet listener is handled safely', async t => {
  const f = fixture(t); f.put('crafting_table');
  f.client.write = () => { f.bot.currentWindow = f.window; f.bot.emit('windowOpen', f.window); f.client.emit('open_window', { windowId: f.window.id }); };
  assert.equal((await f.runCraft()).state, 'COMPLETED');
});
test('unexpected chest window is not treated as a crafting table', async t => {
  const f = fixture(t); f.put('crafting_table'); f.window.type = 'minecraft:chest';
  assert.equal((await f.runCraft()).state, 'FAILED'); await settle();
  assert.equal(f.calls.some(c => c[0] === 'craft'), false);
});
test('cancellation after confirmed open closes known window without reconnect quarantine', async t => {
  const f = fixture(t); f.put('crafting_table'); let finish; const entered = latch();
  const pending = f.runCraft({ craft: () => new Promise(resolve => { finish = resolve; entered.resolve(); }) }); await entered.promise;
  f.arbiter.cancel('death'); finish({}); await settle();
  assert.equal((await pending).state, 'CANCELLED'); assert.equal(f.bot.currentWindow, null);
  assert.equal(inspectWorkspaces(f.bot, policy).reconnectRequired, false);
});
test('disconnect removes persistent response listeners', async t => {
  const f = fixture(t); f.put('crafting_table'); await f.runCraft();
  assert.equal(f.client.listenerCount('open_window'), 1);
  f.bot.emit('end'); assert.equal(f.client.listenerCount('open_window'), 0); assert.equal(f.bot.listenerCount('windowOpen'), 0);
});
test('approved work area is independent of mining and has strict bounds', () => {
  const env = { MC_HOST: 'example.org', MC_AUTH: 'offline' };
  assert.equal(parseConfig(env, 'alice').workspacePolicy.enabled, false);
  for (const area of ['', '1,2,3', '0,-65,0,4,65,4', '4,64,0,0,65,4']) assert.throws(() => parseConfig({ ...env, MC_WORKSPACE_ENABLED: 'true', MC_WORKSPACE_AREA: area }, 'alice'));
  const cfg = parseConfig({ ...env, MC_WORKSPACE_ENABLED: 'true', MC_WORKSPACE_AREA: '-5,64,-5,5,64,5' }, 'alice');
  assert.equal(cfg.workspacePolicy.enabled, true); assert.equal(cfg.miningPolicy.enabled, false);
});
test('interaction packet matches the pinned Minecraft 1.21.1 serializer', async t => {
  const f = fixture(t); let packet;
  f.client.write = (name, data) => { packet = { name, params: data }; };
  await f.arbiter.run('strategy', 100, s => sendTopInteraction(f.bot, f.put('crafting_table'), s));
  const fromMineflayer = createRequire(import.meta.resolve('mineflayer'));
  const protocol = fromMineflayer('minecraft-protocol');
  const serializer = protocol.createSerializer({ state: protocol.states.PLAY, isServer: false, version: '1.21.1' });
  const bytes = serializer.createPacketBuffer(packet);
  assert.ok(bytes.length > 0); assert.equal(packet.name, 'block_place'); assert.equal(packet.params.sequence, 0);
});
test('automatic open feeds the real guarded crafting handler in a simulated 3x3 workflow', async () => {
  const f = craftFixture(true), bot = f.bot, w = world();
  Object.setPrototypeOf(bot, EventEmitter.prototype); EventEmitter.call(bot);
  f.window.slots.fill(null); f.put('oak_planks', 3); f.put('stick', 2, 11);
  bot.inventory = { slots: Array(46).fill(null), selectedItem: null, items: () => [] };
  bot.currentWindow = null; bot.heldItem = null; bot.game = { dimension: 'overworld' }; bot.blockAt = w.blockAt;
  bot.lookAt = async () => {}; w.put('crafting_table');
  bot._client.write = () => { bot._client.emit('open_window', { windowId: f.window.id }); bot.currentWindow = f.window; bot.emit('windowOpen', f.window); };
  try {
    const result = await f.arbiter.run('strategy', 100, s => craftAtTable(bot, craftArgs, policy, s, { arbiter: f.arbiter }));
    assert.equal(result.state, 'COMPLETED'); assert.equal(result.result.serverInventoryVerified, true);
    assert.equal(result.result.outputCountObserved, 1); assert.equal(bot.currentWindow, null);
    assert.equal(f.calls.filter(call => call[0] === 'close').length, 1);
  } finally { bot.emit('end'); }
});
test('main-inventory table staging uses one bounded number-key swap, never equip/toss helpers', async t => {
  const f = fixture(t); f.bot.heldItem = null; f.item.slot = 9;
  f.bot.inventory.slots[9] = f.item; f.bot.inventory.slots[36] = null;
  f.bot.equip = () => assert.fail('high-level equip used'); f.bot.unequip = () => assert.fail('high-level unequip used');
  const result = await f.runPlace();
  assert.equal(result.state, 'COMPLETED');
  assert.deepEqual(f.calls.find(c => c[0] === 'click'), ['click', 9, 0, 2]);
});
test('full hotbar refuses empty-hand opening instead of dropping an item', async t => {
  const f = fixture(t); f.put('crafting_table');
  for (let i = 36; i < 45; i++) f.bot.inventory.slots[i] = { name: 'dirt', count: 64, slot: i };
  f.bot.unequip = () => assert.fail('unsafe unequip used');
  assert.equal((await f.runCraft()).state, 'FAILED'); assert.equal(f.calls.some(c => c[0] === 'block_place'), false);
});
test('main-inventory staging requires server resynchronization', async t => {
  const f = fixture(t); f.bot.heldItem = null; f.item.slot = 9; f.bot.inventory.slots[9] = f.item; f.bot.inventory.slots[36] = null;
  f.bot._syncWindow = async () => {};
  assert.equal((await f.runPlace()).state, 'FAILED'); assert.equal(f.calls.some(c => c[0] === 'click'), false);
});
test('ambiguous multiple server opens cannot start crafting', async t => {
  const f = fixture(t); f.put('crafting_table');
  f.client.write = () => { f.client.emit('open_window', { windowId: 4 }); f.client.emit('open_window', { windowId: 5 }); f.bot.currentWindow = f.window; f.bot.emit('windowOpen', f.window); };
  assert.equal((await f.runCraft()).state, 'FAILED'); await settle();
  assert.equal(f.calls.some(c => c[0] === 'craft'), false);
  assert.equal(inspectWorkspaces(f.bot, policy).reconnectRequired, true);
});
test('late windows cannot be reused across death and respawn', async t => {
  const f = fixture(t); const sent = latch(); f.put('crafting_table'); f.client.write = () => { sent.resolve(); };
  const pending = f.runCraft({ responseTimeoutMs: 500 }); await sent.promise;
  f.bot.health = 0; f.arbiter.cancel('death'); assert.equal((await pending).state, 'CANCELLED');
  f.open(); await settle(); assert.equal(f.calls.some(c => c[0] === 'close'), false);
  f.bot.health = 20; f.bot.emit('spawn'); await settle();
  assert.equal(f.bot.currentWindow, null); assert.equal(inspectWorkspaces(f.bot, policy).reconnectRequired, true);
});
test('late window close waits for its safety action and handles a newer late window', async t => {
  const f = fixture(t); f.put('crafting_table'); f.client.write = () => {};
  assert.equal((await f.runCraft({ responseTimeoutMs: 20 })).state, 'FAILED');
  let finish; const entered = latch(); const close = f.bot.closeWindow;
  f.bot.closeWindow = async win => { await close(win); await new Promise(resolve => { finish = resolve; entered.resolve(); }); };
  f.open(); await settle();
  const other = { ...f.window, id: 6 }; f.bot.currentWindow = other; f.bot.emit('windowOpen', other);
  await settle(); f.bot.closeWindow = close; finish(); await settle();
  assert.equal(f.bot.currentWindow, null);
  assert.equal(f.calls.filter(c => c[0] === 'close').length, 2);
});
test('cancelled placement cleans acknowledgement listener and never claims rollback', async t => {
  const f = fixture(t); const sent = latch(); f.client.write = (name, packet) => { f.calls.push([name, packet]); sent.resolve(); };
  const pending = f.runPlace({ responseTimeoutMs: 500 }); await sent.promise;
  f.arbiter.cancel('danger'); assert.equal((await pending).state, 'CANCELLED');
  assert.equal(f.client.listenerCount('block_change'), 0);
  f.put('crafting_table'); f.client.emit('block_change', { location: point, type: 2 });
  assert.equal(f.calls.filter(c => c[0] === 'block_place').length, 1);
});
test('world-scoped table placement and use retain actual placement and table safety checks', async t => {
  const f = fixture(t), worldPolicy = autonomousWorldPolicy();
  const registry = createToolRegistry({ workspacePolicy: worldPolicy });
  const result = await registry.execute(f.bot, f.arbiter, { tool: 'place_crafting_table', args: point, reason: '' }, {});
  assert.equal(result.state, 'COMPLETED'); assert.doesNotThrow(() => checkTable(f.bot, point, worldPolicy));
  f.bot.health = 4; assert.throws(() => checkTable(f.bot, point, worldPolicy));
});
test('world-scoped placement rejects dimension change during aim before any block interaction', async t => {
  const f = fixture(t); f.bot.lookAt = async () => { f.bot.game.dimension = 'the_nether'; };
  const result = await createToolRegistry({ workspacePolicy: autonomousWorldPolicy() }).execute(f.bot, f.arbiter, { tool: 'place_crafting_table', args: point, reason: '' }, {});
  assert.equal(result.state, 'FAILED'); assert.equal(result.reason, 'workspace_body_changed');
  assert.equal(f.calls.some(([name]) => name === 'block_place'), false);
});
test('world-scoped table opening rejects a replaced body during aim', async t => {
  const f = fixture(t); f.put('crafting_table'); f.bot.lookAt = async () => { f.bot.entity = { ...f.bot.entity }; };
  const result = await createToolRegistry({ workspacePolicy: autonomousWorldPolicy() }).execute(f.bot, f.arbiter, { tool: 'craft_at_table', args: craftArgs, reason: '' }, {});
  assert.equal(result.state, 'FAILED'); assert.equal(result.reason, 'workspace_body_changed');
  assert.equal(f.calls.some(([name]) => name === 'block_place'), false);
});
