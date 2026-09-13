import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { ControlArbiter } from '../src/control.js';
import { autonomousWorldPolicy } from '../src/permissions.js';
import { plantCrop } from '../shared/tools/plant.js';
import { cropAges, cropSeeds } from '../shared/tools/farm.js';
import { vec } from './craft-fixture.js';
const require = createRequire(import.meta.resolve('mineflayer'));
export const data = require('prismarine-registry')('1.21.1');
const Block = require('prismarine-block')(data);
const point = { x: 2, y: 64, z: 0 }, args = { ...point, crop: 'carrots' }, policy = autonomousWorldPolicy();
export function fixture() {
  const slots = Array(46).fill(null), cells = new Map(), calls = [], client = new EventEmitter(); client.state = 'play';
  function block(name, x, y, z, age = 0) {
    const definition = data.blocksByName[name];
    const decoded = Block.fromStateId(definition.defaultState, 0);
    return { name, stateId: Object.hasOwn(cropAges, name) ? definition.minStateId + age : definition.defaultState, position: vec(x, y, z), boundingBox: decoded.boundingBox, shapes: decoded.shapes, getProperties: () => ({ age: String(age) }), diggable: true, canHarvest: () => true };
  }
  const put = (name, x = 2, y = 64, z = 0, age = 0) => { const b = block(name, x, y, z, age); cells.set(`${x},${y},${z}`, b); return b; };
  put('air'); put('farmland', 2, 63, 0);
  const bot = {
    version: '1.21.1', _client: client, registry: data, QUICK_BAR_START: 36, quickBarSlot: 0,
    entity: { id: 1, position: vec(0.5, 64, 0.5), onGround: true }, entities: {}, game: { dimension: 'overworld' },
    health: 20, food: 20, oxygenLevel: 20, inventory: { slots, selectedItem: null, items: () => slots.filter(Boolean) }, currentWindow: null,
    blockAt: p => cells.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || block(Math.floor(p.y) < 64 ? 'stone' : 'air', Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    setQuickBarSlot: index => { calls.push(['held', index]); bot.quickBarSlot = index; },
    lookAt: async () => { calls.push(['look']); },
    clickWindow: async (slot, hotbar, mode) => { calls.push(['click', slot, hotbar, mode]); [slots[slot], slots[36 + hotbar]] = [slots[36 + hotbar], slots[slot]]; },
    clearControlStates: () => calls.push(['stop']),
    canDigBlock: () => true, digTime: () => 0, stopDigging: () => calls.push(['stop'])
  };
  Object.defineProperty(bot, 'heldItem', { get: () => slots[36 + bot.quickBarSlot] });
  function seed(name = 'carrot', count = 3, slot = 36) { slots[slot] = { name, count, slot, type: data.itemsByName[name].id }; }
  const snapshot = () => ({ windowId: 0, items: slots.map(item => item ? { itemId: item.type, itemCount: item.count } : { itemCount: 0 }), carriedItem: { itemCount: 0 } });
  bot._syncWindow = async () => { calls.push(['sync']); client.emit('window_items', snapshot()); };
  const plant = (crop, { consume = 1, age = 0, packet = true } = {}) => {
    const held = bot.heldItem; held.count -= consume; if (!held.count) slots[36 + bot.quickBarSlot] = null;
    const b = put(crop, 2, 64, 0, age);
    if (packet) client.emit('block_change', { location: point, type: b.stateId });
  };
  client.write = (name, params) => { calls.push([name, params]); plant(Object.keys(cropSeeds).find(crop => cropSeeds[crop] === bot.heldItem.name)); };
  bot.dig = async b => { calls.push(['dig']); put('air'); client.emit('block_change', { location: b.position, type: data.blocksByName.air.minStateId }); };
  const arbiter = new ControlArbiter(() => calls.push(['stop']));
  const run = (options = {}, goal = args, permission = policy) => arbiter.run('strategy', 100, session => plantCrop(bot, goal, permission, session, options), 12000);
  seed();
  return { bot, client, slots, calls, put, seed, snapshot, plant, arbiter, run };
}
