import { farmPassable } from '../../src/farming/terrain.js';
import { mayPlantSeed } from '../../src/farming/reservations.js';
import { bindBodySession } from '../../src/control.js';
import { cropSeeds, cropAges, FarmingError, checkFarmBody, checkFarmSite, boundedFarm } from './farm.js';
import { readBlock, sameBlock, isAir } from './resources.js';
const fail = code => { throw new FarmingError(code); };
const validSeed = (item, seed, id) => item?.name === seed && item.type === id && Number.isInteger(item.count) && item.count > 0 && item.count <= 64;
function topVisible(bot, soil) {
  const eye = bot.entity.position.offset(0, 1.62, 0), end = soil.position.offset(0.5, 15 / 16, 0.5);
  const distance = eye.distanceTo(end);
  if (distance > 4) return false;
  const steps = Math.max(1, Math.ceil(distance / 0.08));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, seen = bot.blockAt(eye.offset((end.x - eye.x) * t, (end.y - eye.y) * t, (end.z - eye.z) * t));
    if (!seen) return false;
    if (sameBlock(seen.position, soil.position)) return true;
    if (!farmPassable(seen)) return false;
  }
  return true;
}
export function checkPlanting(bot, args, policy, soilState) {
  if (!Object.hasOwn(cropSeeds, args.crop)) fail('plant_unsupported_crop');
  const soil = checkFarmSite(bot, args, policy, soilState);
  if (!isAir(readBlock(bot, args))) fail('plant_cell_occupied');
  if (!topVisible(bot, soil)) fail('plant_soil_unreachable');
  return soil;
}
function rawStack(item) {
  if (item?.itemCount === 0) return null;
  if (!Number.isInteger(item?.itemId) || item.itemId < 0 || !Number.isInteger(item.itemCount) || item.itemCount < 1 || item.itemCount > 64) fail('plant_invalid_inventory_packet');
  return { type: item.itemId, count: item.itemCount };
}
async function snapshot(bot, session, type, ms) {
  if (typeof bot._syncWindow !== 'function') fail('plant_sync_unavailable');
  let packet;
  const onItems = value => {
    if (value.windowId !== 0 || !Array.isArray(value.items)) return;
    try { packet = { slots: Array.from(value.items, rawStack), cursor: rawStack(value.carriedItem) }; } catch { packet = null; }
  };
  const cleanup = () => bot._client.removeListener('window_items', onItems);
  session.addCleanup(cleanup); bot._client.on('window_items', onItems);
  try {
    await boundedFarm(session.guard(() => bot._syncWindow(bot.inventory)), session.signal, ms, 'plant_sync_timeout');
    session.guard(() => {}); checkFarmBody(bot);
    if (!packet || packet.slots.length !== bot.inventory.slots.length || packet.slots.length < 45 || packet.cursor || packet.slots.slice(0, 5).some(Boolean)) fail('plant_inventory_unconfirmed');
    return { slots: packet.slots, count: packet.slots.slice(9, 45).reduce((sum, item) => sum + (item?.type === type ? item.count : 0), 0) };
  } finally { cleanup(); }
}
async function stageSeed(bot, seed, id, session, baseline, ms, recheck) {
  if (validSeed(bot.heldItem, seed, id)) return baseline;
  if (bot.QUICK_BAR_START !== 36 || typeof bot.setQuickBarSlot !== 'function') fail('plant_hotbar_unavailable');
  const hotbar = bot.inventory.slots.slice(36, 45).findIndex(item => validSeed(item, seed, id));
  if (hotbar >= 0) { session.guard(() => bot.setQuickBarSlot(hotbar)); return baseline; }
  const main = bot.inventory.slots.slice(9, 36).findIndex(item => validSeed(item, seed, id));
  const empty = bot.inventory.slots.slice(36, 45).findIndex(item => item == null);
  if (main < 0) fail('plant_seed_missing');
  if (empty < 0 || typeof bot.clickWindow !== 'function') fail('plant_empty_hotbar_required');
  // Main slots <36 avoid Mineflayer's delayed post-dig hotbar-click branch.
  // Number-key swap into an empty hotbar slot never uses the cursor or tosses.
  await boundedFarm(session.guard(() => bot.clickWindow(main + 9, empty, 2)), session.signal, ms, 'plant_staging_timeout');
  session.guard(() => {}); recheck();
  const staged = await snapshot(bot, session, id, ms);
  recheck();
  if (!validSeed(bot.inventory.slots[36 + empty], seed, id) || staged.slots[36 + empty]?.type !== id || staged.count < 1) fail('plant_staging_unconfirmed');
  session.guard(() => bot.setQuickBarSlot(empty));
  return staged;
}
// Narrow 1.21.1 adapter: farmland top face, main hand only. No arbitrary packet
// fields or generic item-use API are exposed to model arguments.
export function sendPlantInteraction(bot, soil, session) {
  if (bot.version !== '1.21.1' || bot._client?.state !== 'play') fail('plant_protocol_unavailable');
  session.guard(() => bot._client.write('block_place', { hand: 0, location: soil.position, direction: 1, cursorX: 0.5, cursorY: 15 / 16, cursorZ: 0.5, insideBlock: false, sequence: 0 }));
}
export async function plantCrop(bot, args, policy, session, { responseMs = 1500 } = {}) {
  session = bindBodySession(bot, session, () => new FarmingError('plant_body_changed'));
  const initial = checkPlanting(bot, args, policy), soilState = initial.stateId;
  if (typeof session.addCleanup !== 'function' || !bot._client?.on || !bot._client?.removeListener || !bot._client?.write) fail('plant_control_unavailable');
  const seed = cropSeeds[args.crop], id = bot.registry?.itemsByName?.[seed]?.id;
  const definition = bot.registry?.blocksByName?.[args.crop], ages = definition?.states?.[0];
  if (!Number.isInteger(id) || id < 0 || definition?.name !== args.crop || !Number.isInteger(definition?.minStateId) || definition.minStateId < 0 || definition.maxStateId - definition.minStateId !== cropAges[args.crop] || !Array.isArray(definition.states) || definition.states.length !== 1 || ages?.name !== 'age' || ages.type !== 'int' || ages.num_values !== cropAges[args.crop] + 1 || !Array.isArray(ages.values) || ages.values.length !== cropAges[args.crop] + 1 || !ages.values.every((value, index) => value === String(index)) || bot.registry?.blocksByStateId?.[definition.minStateId]?.name !== args.crop) fail('plant_registry_unavailable');
  const ageZero = definition.minStateId;
  const recheck = () => { session.guard(() => {}); if (!mayPlantSeed(bot, seed, args)) fail('plant_seed_reserved'); return checkPlanting(bot, args, policy, soilState); };
  let before = await snapshot(bot, session, id, responseMs);
  recheck();
  if (before.count < 1) fail('plant_seed_missing');
  before = await stageSeed(bot, seed, id, session, before, responseMs, recheck);
  let soil = recheck();
  if (!Number.isInteger(bot.quickBarSlot) || bot.quickBarSlot < 0 || bot.quickBarSlot > 8 || before.slots[36 + bot.quickBarSlot]?.type !== id) fail('plant_selected_seed_unconfirmed');
  if (!validSeed(bot.heldItem, seed, id)) fail('plant_hand_changed');
  await boundedFarm(session.guard(() => bot.lookAt(soil.position.offset(0.5, 15 / 16, 0.5), true)), session.signal, responseMs, 'plant_aim_timeout');
  soil = recheck();
  if (!validSeed(bot.heldItem, seed, id)) fail('plant_hand_changed');
  let sent = false, observed = false, resolve, reject, monitor, failure;
  const response = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A synchronous packet write can fail after a reentrant test/plugin event.
  // Keep an observer attached even if control exits before the bounded await.
  response.catch(() => {});
  const invalidate = error => { failure ||= error; reject(error); };
  const onBlock = packet => {
    if (!sent || observed || !sameBlock(packet.location, args)) return;
    try {
      session.guard(() => {}); checkFarmSite(bot, args, policy, soilState);
      if (packet.type !== ageZero) fail('plant_unexpected_block');
      observed = true; resolve();
    } catch (error) { invalidate(error); }
  };
  const cleanup = () => { clearInterval(monitor); bot._client.removeListener('block_change', onBlock); };
  session.addCleanup(cleanup); bot._client.on('block_change', onBlock);
  monitor = setInterval(() => {
    try { session.guard(() => {}); checkFarmSite(bot, args, policy, soilState); }
    catch (error) { invalidate(error); }
  }, 50);
  try {
    // Final site and hand validation is immediately adjacent to the packet write.
    soil = recheck();
    if (!validSeed(bot.heldItem, seed, id)) fail('plant_hand_changed');
    sent = true; sendPlantInteraction(bot, soil, session);
    await boundedFarm(response, session.signal, responseMs, 'plant_server_confirmation_missing');
    if (failure) throw failure;
    const after = await snapshot(bot, session, id, responseMs);
    if (failure) throw failure;
    session.guard(() => {}); checkFarmSite(bot, args, policy, soilState);
    if (!observed || before.count - after.count !== 1) fail('plant_consumption_unconfirmed');
    return { crop: args.crop, position: { x: args.x, y: args.y, z: args.z }, serverObservedSeedling: true, seed, seedCountBefore: before.count, seedCountAfter: after.count, serverInventoryVerified: true, exclusiveCausalityClaimed: false, futureGrowthGuaranteed: false };
  } finally { cleanup(); }
}
