import { EventEmitter } from 'node:events';
import { ControlArbiter } from '../src/control.js';
import { craftOne } from '../shared/tools/craft.js';

export function vec(x, y, z) { return { x, y, z, offset(dx, dy, dz) { return vec(x + dx, y + dy, z + dz); }, distanceTo(p) { return Math.hypot(x - p.x, y - p.y, z - p.z); } }; }
const ids = { oak_log: 1, oak_planks: 2, stick: 3, crafting_table: 4, wooden_pickaxe: 5, cobblestone: 6, stone_pickaxe: 7 };
const ingredient = id => ({ id, metadata: null, count: 1 });
function recipe(item, shape, ingredients = null, count = 1, requiresTable = false) { return { result: { id: ids[item], count }, inShape: shape?.map(row => row.map(ingredient)) || null, ingredients, outShape: null, requiresTable }; }
export function craftFixture(table = false) {
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
