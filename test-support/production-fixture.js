import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fixture as base, data } from './farm-fixture.js';
import { vec } from './craft-fixture.js';
import { FURNACE_RECIPES } from '../shared/tools/cook.js';
const require = createRequire(import.meta.resolve('mineflayer')), Block = require('prismarine-block')(data);
export { data, vec };
export function fixture() {
  const f = base(), event = new EventEmitter(); f.bot.on = event.on.bind(event); f.bot.removeListener = event.removeListener.bind(event); f.bot.emit = event.emit.bind(event);
  f.bot.entity.position = vec(1.5, 64, 0.5); f.slots[36] = null;
  const basePut = f.put;
  f.put = (name, x = 2, y = 63, z = 0, age = 0, properties = {}) => {
    const b = basePut(name, x, y, z, age), decoded = Block.fromStateId(b.stateId, 0);
    b.getProperties = () => ({ ...decoded.getProperties(), ...properties });
    b.light = 0; b.skyLight = 15; return b;
  };
  f.put('dirt'); f.reply = true; f.consume = true; f.autoCook = false; f.furnaceState = [null, null, null]; f.furnacePosition = { x: 2, y: 64, z: 0 }; f.lastWindow = null;
  const change = (name, p, age = 0) => { const b = f.put(name, p.x, p.y, p.z, age); if (f.reply) f.client.emit('block_change', { location: { x: p.x, y: p.y, z: p.z }, type: b.stateId }); return b; };
  const use = replacement => {
    if (!f.consume) return;
    const slot = 36 + f.bot.quickBarSlot, stack = f.slots[slot];
    if (replacement) f.seed(replacement, 1, slot);
    else { stack.count--; if (!stack.count) f.slots[slot] = null; }
  };
  f.bot.dig = async b => { f.calls.push(['dig', b.position]); change('air', b.position); };
  const originalSync = f.bot._syncWindow;
  function raw(w) { return { windowId: w.id, items: w.slots.map(s => s ? { itemId: s.type, itemCount: s.count } : { itemCount: 0 }), carriedItem: w.selectedItem ? { itemId: w.selectedItem.type, itemCount: w.selectedItem.count } : { itemCount: 0 } }; }
  f.bot._syncWindow = async w => { if (w === f.bot.inventory) return originalSync(w); f.calls.push(['sync', w.id]); f.client.emit('window_items', raw(w)); };
  f.bot.closeWindow = w => {
    if (f.bot.currentWindow !== w) return;
    f.furnaceState = w.slots.slice(0, 3).map(s => s && { ...s });
    for (let i = 3; i < 39; i++) f.slots[i + 6] = w.slots[i] && { ...w.slots[i], slot: i + 6 };
    f.bot.currentWindow = null; f.calls.push(['close', w.id]);
  };
  f.open = (type = 'minecraft:furnace') => {
    const w = { id: 4, type, inventoryStart: 3, inventoryEnd: 39, slots: [...f.furnaceState.map(s => s && { ...s }), ...f.slots.slice(9, 45).map(s => s && { ...s })], selectedItem: null };
    f.lastWindow = w; f.client.emit('open_window', { windowId: 4 }); f.bot.currentWindow = w; f.bot.emit('windowOpen', w);
  };
  f.finishCooking = (w = f.bot.currentWindow) => {
    if (!w?.slots[0] || !FURNACE_RECIPES[w.slots[0].name] || w.slots[2]) return;
    const lit = f.bot.blockAt(vec(f.furnacePosition.x, f.furnacePosition.y, f.furnacePosition.z)).getProperties?.().lit;
    if (!w.slots[1] && lit !== 'true' && lit !== true) return;
    const name = FURNACE_RECIPES[w.slots[0].name];
    w.slots[0] = null; w.slots[1] = null; w.slots[2] = { name, type: data.itemsByName[name].id, count: 1 };
    f.put('furnace', f.furnacePosition.x, f.furnacePosition.y, f.furnacePosition.z, 0, { lit: 'true' });
  };
  const playerClick = f.bot.clickWindow;
  f.bot.clickWindow = async (slot, button, mode) => {
    const w = f.bot.currentWindow;
    if (!w) return playerClick(slot, button, mode);
    f.calls.push(['click', slot, button, mode]);
    if (mode === 2) { [w.slots[slot], w.slots[30 + button]] = [w.slots[30 + button], w.slots[slot]]; return; }
    if (button === 1) {
      const held = w.selectedItem; if (!held) throw new Error('no cursor');
      w.slots[slot] = { ...held, count: 1 }; held.count--; if (!held.count) w.selectedItem = null;
    } else if (w.selectedItem) { if (w.slots[slot]) w.slots[slot].count += w.selectedItem.count; else w.slots[slot] = { ...w.selectedItem }; w.selectedItem = null; }
    else { w.selectedItem = w.slots[slot]; w.slots[slot] = null; }
    if (f.autoCook) f.finishCooking(w);
  };
  f.client.write = (name, packet) => {
    f.calls.push([name, packet]); const item = f.bot.heldItem?.name;
    if (name === 'use_item') {
      const yaw = Math.PI - packet.rotation.x * Math.PI / 180, pitch = -packet.rotation.y * Math.PI / 180;
      const eye = f.bot.entity.position.offset(0, 1.62, 0);
      for (let d = 0; d < 4.05; d += 0.01) {
        const p = eye.offset(-Math.sin(yaw) * Math.cos(pitch) * d, Math.sin(pitch) * d, -Math.cos(yaw) * Math.cos(pitch) * d), b = f.bot.blockAt(p);
        if (item === 'bucket' && b.name === 'water') { change('air', b.position); use('water_bucket'); break; }
        if (b.boundingBox === 'block') { if (item === 'water_bucket') { change('water', b.position.offset(0, 1, 0)); use('bucket'); } break; }
      }
      return;
    }
    if (name !== 'block_place') return;
    const p = packet.location, b = f.bot.blockAt(vec(p.x, p.y, p.z));
    if (!item && b.name === 'furnace') { f.furnacePosition = p; f.open(); return; }
    if (item?.endsWith('_hoe')) { change(b.name === 'coarse_dirt' ? 'dirt' : 'farmland', p); return; }
    if (item === 'bone_meal') { change(b.name, p, Number(b.getProperties().age) + 1); use(); return; }
    if (['torch', 'cobblestone', 'crafting_table', 'furnace'].includes(item)) { change(item, vec(p.x, p.y + 1, p.z)); use(); return; }
  };
  f.run = async (fn, args = { x: 2, y: 63, z: 0 }, policy, options = {}) => {
    let failure;
    const result = await f.arbiter.run('strategy', 100, async session => {
      try { return await fn(f.bot, args, policy, session, { ms: 100, arbiter: f.arbiter, ...options }); } catch (error) { failure = error; throw error; }
    }, 15000);
    return result.state === 'FAILED' ? { ...result, reason: failure?.code || result.reason } : result;
  };
  f.dispose = () => { f.arbiter.cancel('test_end'); f.bot.emit('end'); };
  return f;
}
