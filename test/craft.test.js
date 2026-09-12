import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as settle } from 'node:timers/promises';
import { planCraft, craftOptions, craftOne } from '../shared/tools/craft.js';
import { createToolRegistry } from '../shared/tools/index.js';
import { validateGoal } from '../src/strategy/goals.js';
import { ControlArbiter } from '../src/control.js';
function vec(x, y, z) { return { x, y, z, offset(dx, dy, dz) { return vec(x + dx, y + dy, z + dz); }, distanceTo(p) { return Math.hypot(x - p.x, y - p.y, z - p.z); } }; }
const ids = { oak_log: 1, oak_planks: 2, stick: 3, crafting_table: 4, wooden_pickaxe: 5, cobblestone: 6, stone_pickaxe: 7 };
const ingredient = id => ({ id, metadata: null, count: 1 });
function recipe(item, shape, ingredients = null, count = 1, requiresTable = false) { return { result: { id: ids[item], count }, inShape: shape?.map(row => row.map(ingredient)) || null, ingredients, outShape: null, requiresTable }; }
function fixture(table = false) {
  const width = table ? 3 : 2;
  const window = { id: table ? 4 : 0, type: table ? 'minecraft:crafting' : 'minecraft:inventory', inventoryStart: table ? 10 : 9, inventoryEnd: table ? 46 : 45, slots: Array(46).fill(null), selectedItem: null };
  window.items = () => window.slots.slice(window.inventoryStart, window.inventoryEnd).filter(Boolean);
  const recipes = [
    recipe('oak_planks', null, [{ id: ids.oak_log, metadata: null, count: -1 }], 4),
    recipe('stick', [[ids.oak_planks], [ids.oak_planks]], null, 4),
    recipe('crafting_table', [[2, 2], [2, 2]]),
    recipe('wooden_pickaxe', [[2, 2, 2], [-1, 3, -1], [-1, 3, -1]], null, 1, true),
    recipe('stone_pickaxe', [[6, 6, 6], [-1, 3, -1], [-1, 3, -1]], null, 1, true)
  ];
  const stack = (type, count, slot) => ({ type, count, slot, name: Object.keys(ids).find(name => ids[name] === type), metadata: 0 });
  const put = (name, count, slot = window.inventoryStart) => { window.slots[slot] = stack(ids[name], count, slot); };
  const cellsFor = r => {
    if (r.requiresTable && width !== 3) return null;
    const cells = new Map();
    if (r.inShape) r.inShape.forEach((row, y) => row.forEach((i, x) => { if (i.id >= 0) cells.set(1 + y * width + x, i.id); }));
    else r.ingredients.forEach((i, j) => cells.set(j + 1, i.id));
    return cells;
  };
  function matching() { return recipes.find(r => { const cells = cellsFor(r); return cells && Array.from({ length: width * width }, (_, i) => i + 1).every(slot => cells.has(slot) ? window.slots[slot]?.type === cells.get(slot) && window.slots[slot].count === 1 : !window.slots[slot]); }); }
  function recompute() { const r = matching(); window.slots[0] = r ? stack(r.result.id, r.result.count, 0) : null; }
  const calls = [];
  const client = new EventEmitter(); client.state = 'play';
  const bot = {
    version: '1.21.1', QUICK_BAR_START: 36, entity: { position: vec(0.5, 64, 0.5), onGround: true }, entities: {}, health: 20, food: 20, oxygenLevel: 20,
    inventory: window, currentWindow: table ? window : null, _client: client,
    registry: { itemsByName: Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, { id, stackSize: 64 }])) },
    blockAt: p => Math.floor(p.y) < 64 ? { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : { name: 'air' },
    recipesAll: id => recipes.filter(r => r.result.id === id),
    closeWindow: w => { calls.push(['close', w.id]); bot.currentWindow = null; return Promise.resolve(); },
    clickWindow: async (slot, button, mode) => {
      calls.push(['click', slot, button, mode]);
      if (slot === 0) {
        window.selectedItem = window.slots[0];
        for (let i = 1; i <= width * width; i++) window.slots[i] = null;
      } else if (button === 1) {
        const held = window.selectedItem;
        if (!held) throw new Error('missing cursor');
        window.slots[slot] = stack(held.type, 1, slot);
        held.count--; if (held.count === 0) window.selectedItem = null;
      } else if (window.selectedItem) {
        if (window.slots[slot]) window.slots[slot].count += window.selectedItem.count;
        else window.slots[slot] = stack(window.selectedItem.type, window.selectedItem.count, slot);
        window.selectedItem = null;
      } else { window.selectedItem = window.slots[slot]; window.slots[slot] = null; }
      recompute();
    }
  };
  const packet = () => ({ windowId: window.id, items: window.slots.map(s => s ? { itemId: s.type, itemCount: s.count } : { itemCount: 0 }), carriedItem: window.selectedItem ? { itemId: window.selectedItem.type, itemCount: window.selectedItem.count } : { itemCount: 0 } });
  bot._syncWindow = async () => { calls.push(['sync']); client.emit('window_items', packet()); };
  const arbiter = new ControlArbiter(() => calls.push(['stop']));
  const craft = (item = 'oak_planks', options = {}) => arbiter.run('strategy', 100, session => craftOne(bot, { item }, session, { stepTimeoutMs: 20, ...options }), 2000);
  put('oak_log', 2);
  return { bot, window, calls, put, recipes, craft, arbiter, packet };
}
test('craft schema only accepts one allowlisted item, never arbitrary quantities or recipes', () => {
  assert.equal(validateGoal({ tool: 'craft', args: { item: 'stick' }, reason: '' }).tool, 'craft');
  for (const args of [{ item: 'tnt' }, { item: 'stick', count: 64 }, { item: 'stick', recipe: {} }]) assert.throws(() => validateGoal({ tool: 'craft', args, reason: '' }));
  assert.equal(createToolRegistry().catalog().some(t => t.name === 'craft_options'), true);
});
test('recipe planner handles negative shapeless counts and shaped inputs', () => {
  const f = fixture();
  const plan = planCraft(f.bot, 'oak_planks'); assert.equal(plan.count, 4); assert.equal(plan.placements.length, 1);
  f.put('oak_planks', 4);
  assert.equal(planCraft(f.bot, 'crafting_table').placements.length, 4);
});
test('crafting options do not move, craft or consume ingredients', () => {
  const f = fixture(); const options = craftOptions(f.bot);
  assert.equal(options.options.find(x => x.item === 'oak_planks').outputCount, 4);
  assert.equal(f.calls.length, 0);
  assert.equal(f.window.slots[9].count, 2);
});
test('hotbar-only ingredients and full main inventory are rejected', () => {
  const f = fixture(); f.window.slots[9] = null; f.put('oak_log', 2, 36);
  assert.throws(() => planCraft(f.bot, 'oak_planks'), /missing_ingredients/);
  for (let i = 9; i < 36; i++) f.put('oak_log', 64, i);
  assert.throws(() => planCraft(f.bot, 'oak_planks'), /no_main_inventory_output_space/);
});
test('dirty crafting grids, occupied cursor and non-crafting windows are refused', () => {
  const f = fixture(); f.put('oak_log', 1, 1);
  assert.throws(() => planCraft(f.bot, 'oak_planks'), /occupied/);
  f.window.slots[1] = null; f.window.selectedItem = { type: 1, count: 1 };
  assert.throws(() => planCraft(f.bot, 'oak_planks'), /occupied/);
  f.window.selectedItem = null; f.window.type = 'minecraft:chest';
  assert.throws(() => planCraft(f.bot, 'oak_planks'), /unsupported_window/);
});
test('tool recipes require an already-open crafting-table window', () => {
  const f = fixture(); f.put('oak_planks', 3); f.put('stick', 2, 10);
  assert.throws(() => planCraft(f.bot, 'wooden_pickaxe'), /crafting_table_window_required/);
  const t = fixture(true); t.put('oak_planks', 3); t.put('stick', 2, 11);
  assert.equal(planCraft(t.bot, 'wooden_pickaxe').placements.length, 5);
});
test('one planks batch consumes one log and confirms four output items', async () => {
  const f = fixture(); const result = await f.craft();
  assert.equal(result.state, 'COMPLETED'); assert.equal(result.result.outputCountObserved, 4);
  assert.equal(f.window.slots[9].count, 1); assert.equal(result.result.serverInventoryVerified, true);
  assert.equal(f.calls.filter(c => c[0] === 'click' && c[1] === 0).length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'close').length, 1);
  assert.equal(f.bot._client.listenerCount('window_items'), 0);
});
test('crafting table and wooden/stone pickaxes work in simulated valid grids', async () => {
  for (const item of ['crafting_table', 'wooden_pickaxe', 'stone_pickaxe']) {
    const f = fixture(item !== 'crafting_table');
    f.put(item === 'stone_pickaxe' ? 'cobblestone' : 'oak_planks', item === 'crafting_table' ? 4 : 3);
    if (item !== 'crafting_table') f.put('stick', 2, 11);
    const result = await f.craft(item);
    assert.equal(result.state, 'COMPLETED', item);
    assert.equal(result.result.outputCountObserved, 1);
  }
});
test('unconfirmed optimistic inventory does not count as crafted output', async () => {
  const f = fixture(); f.bot._syncWindow = async () => {};
  assert.equal((await f.craft()).state, 'FAILED');
  assert.equal(craftOptions(f.bot).recoveryRequired, true);
});
test('server snapshot with wrong output, cursor or ingredient delta is rejected', async () => {
  for (const corrupt of [packet => { packet.items[10] = { itemCount: 0 }; }, packet => { packet.carriedItem = { itemId: 2, itemCount: 4 }; }, packet => { packet.items[9] = { itemId: 1, itemCount: 2 }; }]) {
    const f = fixture(); f.bot._syncWindow = async () => { const p = f.packet(); corrupt(p); f.bot._client.emit('window_items', p); };
    assert.equal((await f.craft()).state, 'FAILED');
  }
});
test('unsafe health, hostile presence and unsupported protocol cause no clicks', async () => {
  for (const change of [f => { f.bot.health = 8; }, f => { f.bot.entities[1] = { name: 'zombie', position: vec(1, 64, 0) }; }, f => { f.bot.version = '1.20.4'; }]) {
    const f = fixture(); change(f); assert.equal((await f.craft()).state, 'FAILED');
    assert.equal(f.calls.some(c => c[0] === 'click'), false);
  }
});
test('cancellation during a delayed click prevents all subsequent clicks', async () => {
  const f = fixture(); let finish; const click = f.bot.clickWindow;
  f.bot.clickWindow = async (...args) => { await click(...args); await new Promise(resolve => { finish = resolve; }); };
  const pending = f.craft(); await settle();
  f.arbiter.cancel('creeper'); finish(); await settle();
  assert.equal((await pending).state, 'CANCELLED');
  assert.equal(f.calls.filter(c => c[0] === 'click').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'close').length, 1);
  assert.equal(craftOptions(f.bot).recoveryRequired, true);
});
test('a changed window after a click is not closed by stale cleanup', async () => {
  const f = fixture(); const click = f.bot.clickWindow;
  f.bot.clickWindow = async (...args) => { await click(...args); f.bot.currentWindow = { id: 9, type: 'minecraft:chest' }; };
  assert.equal((await f.craft()).state, 'FAILED');
  assert.equal(f.calls.filter(c => c[0] === 'close').length, 0);
});
test('hung click and hung synchronization are bounded', async () => {
  for (const method of ['clickWindow', '_syncWindow']) {
    const f = fixture(); f.bot[method] = () => new Promise(() => {});
    assert.equal((await f.craft()).state, 'FAILED');
    assert.equal(f.bot._client.listenerCount('window_items'), 0);
  }
});
test('interrupted inventory remains blocked until a clean authoritative resync', async () => {
  const f = fixture(); const originalClick = f.bot.clickWindow;
  f.bot.clickWindow = async (...args) => { await originalClick(...args); throw new Error('interrupted'); };
  assert.equal((await f.craft()).state, 'FAILED');
  f.bot.clickWindow = originalClick;
  assert.equal((await f.craft()).state, 'FAILED'); // Server still reports occupied cursor.
  f.window.selectedItem = null; f.window.slots.fill(null); f.put('oak_log', 2);
  assert.equal((await f.craft()).state, 'COMPLETED');
  assert.equal(craftOptions(f.bot).recoveryRequired, false);
});
test('session cleanup executes once before a higher-priority action begins', async () => {
  const order = []; const arbiter = new ControlArbiter(() => order.push('stop'));
  const first = arbiter.run('craft', 100, async ({ addCleanup }) => { addCleanup(() => order.push('close')); await new Promise(() => {}); });
  await settle(); await arbiter.run('reflex', 1000, () => order.push('reflex'));
  assert.equal((await first).state, 'CANCELLED');
  assert.ok(order.indexOf('close') < order.indexOf('reflex'));
  assert.equal(order.filter(x => x === 'close').length, 1);
});
test('failing body cleanup does not suppress session resource cleanup', async () => {
  let cleaned = 0;
  const arbiter = new ControlArbiter(() => { throw new Error('connection closed'); });
  const result = await arbiter.run('craft', 100, ({ addCleanup }) => { addCleanup(() => { cleaned++; }); });
  assert.equal(result.state, 'COMPLETED'); assert.equal(cleaned, 1);
});
test('missing confirmation API refuses to consume ingredients', async () => {
  const f = fixture(); delete f.bot._syncWindow;
  assert.equal((await f.craft()).state, 'FAILED'); assert.equal(f.calls.some(c => c[0] === 'click'), false);
});
test('craft planner matches the pinned Mineflayer Minecraft 1.21.1 recipe data', async () => {
  // Inspect Mineflayer's own resolved dependencies: this is an offline API/data
  // contract test, not a replacement for a live crafting test.
  const { createRequire } = await import('node:module');
  const fromMineflayer = createRequire(import.meta.resolve('mineflayer'));
  const registry = fromMineflayer('prismarine-registry')('1.21.1');
  const Recipe = fromMineflayer('prismarine-recipe')(registry).Recipe;
  const cases = [
    ['oak_planks', false, [['oak_log', 1]], 4],
    ['stick', false, [['oak_planks', 2]], 4],
    ['crafting_table', false, [['oak_planks', 4]], 1],
    ['wooden_pickaxe', true, [['oak_planks', 3], ['stick', 2]], 1],
    ['stone_pickaxe', true, [['cobblestone', 3], ['stick', 2]], 1]
  ];
  for (const [item, table, inputs, output] of cases) {
    const f = fixture(table); f.window.slots.fill(null);
    f.bot.registry = registry; f.bot.recipesAll = id => Recipe.find(id, null);
    inputs.forEach(([name, count], i) => { const slot = f.window.inventoryStart + i; f.window.slots[slot] = { name, type: registry.itemsByName[name].id, count, metadata: 0, slot }; });
    const plan = planCraft(f.bot, item); assert.equal(plan.count, output, item);
    assert.ok(plan.placements.every(p => p.source < 36));
  }
});
test('registry exposes crafting failures as bounded diagnostic codes', async () => {
  const f = fixture(); f.bot.health = 5;
  const registry = createToolRegistry(); const events = [];
  const result = await registry.execute(f.bot, f.arbiter, { tool: 'craft', args: { item: 'oak_planks' }, reason: '' }, { emit: e => events.push(e) });
  assert.equal(result.reason, 'unsafe_crafting_body');
  assert.equal(events[0].type, 'CRAFT-RESULT');
});
test('death skips inventory cleanup writes and prevents delayed continuation', async () => {
  const f = fixture(); let finish; const click = f.bot.clickWindow;
  f.bot.clickWindow = async (...args) => { await click(...args); await new Promise(resolve => { finish = resolve; }); };
  const pending = f.craft(); await settle(); f.bot.health = 0;
  f.arbiter.cancel('death'); finish(); await settle();
  assert.equal((await pending).state, 'CANCELLED');
  assert.equal(f.calls.filter(c => c[0] === 'click').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'close').length, 0);
});
test('occupied output destination is not overwritten after picking up a result', async () => {
  const f = fixture(); const click = f.bot.clickWindow;
  f.bot.clickWindow = async (...args) => { await click(...args); if (args[0] === 0) f.put('oak_log', 1, 10); };
  const result = await f.craft();
  assert.equal(result.state, 'FAILED');
  assert.equal(f.calls.some(c => c[0] === 'click' && c[1] === 10), false);
});
