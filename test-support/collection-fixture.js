import { EventEmitter } from 'node:events';
import { ControlArbiter } from '../src/control.js';
import { collectItems, collectNearby } from '../shared/tools/collect.js';
import { vec } from './craft-fixture.js';
export const uuid = '12345678-1234-4234-8234-123456789abc';
export const args = { entityId: 101, entityUuid: uuid, expectedItem: 'oak_log' };
export const policy = { enabled: true, dimension: 'overworld', area: { minX: -5, minY: 64, minZ: -5, maxX: 5, maxY: 64, maxZ: 5 } };
export function fixture() {
  let clock = 0, yaw = 0, forward = false;
  const client = new EventEmitter(); client.state = 'play';
  const item = { name: 'oak_log', type: 1, count: 4 };
  const target = { id: 101, uuid, name: 'item', isValid: true, position: vec(2.5, 64.1, 0.5), getDroppedItem: () => ({ ...item }) };
  const slots = Array(46).fill(null), calls = [], changes = new Map();
  const bot = {
    version: '1.21.1', _client: client, entity: { id: 1, position: vec(0.5, 64, 0.5), onGround: true }, entities: { 101: target },
    health: 20, food: 20, oxygenLevel: 20, currentWindow: null, game: { dimension: 'overworld' },
    inventory: { slots, selectedItem: null, items: () => slots.slice(9, 45).filter(Boolean) },
    registry: { itemsByName: { oak_log: { id: 1, stackSize: 64 }, dirt: { id: 2, stackSize: 64 } } },
    blockAt: p => changes.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? (Math.floor(p.y) < 64 ? { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : { name: 'air' }),
    look: async y => { yaw = y; calls.push(['look']); },
    setControlState: (key, value) => { if (key === 'forward') forward = value; calls.push([key, value]); },
    clearControlStates: () => { forward = false; calls.push(['stop']); }
  };
  const snapshot = () => ({ windowId: 0, items: slots.map(item => item ? { itemId: item.type, itemCount: item.count } : { itemCount: 0 }), carriedItem: { itemCount: 0 } });
  let snapshots = 0;
  bot._syncWindow = async () => { snapshots++; client.emit('window_items', snapshot()); };
  function pickup({ collector = bot.entity.id, count = item.count, gain = count, remove = true, id = 101 } = {}) {
    client.emit('collect', { collectedEntityId: id, collectorEntityId: collector, pickupItemCount: count });
    if (collector === bot.entity.id && gain > 0) slots[9] = { name: 'oak_log', type: 1, count: (slots[9]?.count || 0) + gain };
    if (remove) delete bot.entities[id];
  }
  const f = { bot, target, item, slots, calls, client, pickup, snapshot, autoPickup: true, onTick: null, get snapshots() { return snapshots; }, get forward() { return forward; } };
  const wait = async (ms, signal) => {
    if (signal.aborted) throw new Error('cancelled');
    clock += ms;
    if (forward) bot.entity.position = bot.entity.position.offset(-Math.sin(yaw) * 0.2, 0, -Math.cos(yaw) * 0.2);
    f.onTick?.();
    if (f.autoPickup && bot.entities[101] && Math.hypot(bot.entity.position.x - target.position.x, bot.entity.position.z - target.position.z) <= 0.65) pickup();
  };
  const arbiter = new ControlArbiter(bot.clearControlStates);
  const run = (options = {}, goal = args, permission = policy) => arbiter.run('strategy', 100, session => collectItems(bot, goal, permission, session, { now: () => clock, wait, ...options }), 10000);
  const nearby = (options = {}, goal = { expectedItem: 'oak_log' }, permission = policy) => arbiter.run('strategy', 100, session => collectNearby(bot, goal, permission, session, { now: () => clock, wait, ...options }), 12000);
  Object.assign(f, { arbiter, run, nearby, wait, setBlock: (x, y, z, value) => changes.set(`${x},${y},${z}`, value), setClock: value => { clock = value; } });
  return f;
}
