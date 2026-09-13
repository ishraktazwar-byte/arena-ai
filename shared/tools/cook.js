import { bindBodySession } from '../../src/control.js';
import { permitsBlock } from '../../src/permissions.js';
import { farmFootprint } from '../../src/farming/terrain.js';
import { worldReader } from '../../src/escape.js';
import { assessRisk, survivalSnapshot } from '../../src/survival.js';
import { seedReserve } from '../../src/farming/reservations.js';
import { readBlock } from './resources.js';
import { FarmingError, boundedFarm } from './farm.js';
import { openCookingWindow } from './workspace.js';
export const COOKING = Object.freeze({ potato: 'baked_potato', beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken', mutton: 'cooked_mutton', rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon' });
export const FURNACE_RECIPES = Object.freeze({ ...COOKING, raw_iron: 'iron_ingot' });
const FUEL = ['coal', 'charcoal'];
const fail = code => { throw new FarmingError(code); };
function stack(raw) {
  if (raw?.itemCount === 0) return null;
  if (!Number.isInteger(raw?.itemId) || raw.itemId < 0 || !Number.isInteger(raw.itemCount) || raw.itemCount < 1 || raw.itemCount > 64) fail('cooking_invalid_inventory');
  return { type: raw.itemId, count: raw.itemCount };
}
async function snapshot(bot, window, session, ms) {
  let packet;
  const onItems = value => { if (value.windowId === window.id && Array.isArray(value.items)) { try { packet = { slots: Array.from(value.items, stack), cursor: stack(value.carriedItem) }; } catch { packet = null; } } };
  const cleanup = () => bot._client.removeListener('window_items', onItems); session.addCleanup(cleanup); bot._client.on('window_items', onItems);
  try {
    await boundedFarm(session.guard(() => bot._syncWindow(window)), session.signal, ms, 'cooking_sync_timeout'); session.guard(() => {});
    if (!packet || packet.slots.length !== window.slots.length || packet.cursor) fail('cooking_inventory_unconfirmed');
    return packet;
  } finally { cleanup(); }
}
const count = (snap, type) => snap.slots.slice(3, 39).reduce((n, item) => n + (item?.type === type ? item.count : 0), 0);
export async function cookFood(bot, args, policy, session, context = {}) {
  session = bindBodySession(bot, session, () => new FarmingError('cooking_body_changed'));
  if (!Object.hasOwn(FURNACE_RECIPES, args.item)) fail('cooking_unsupported_food');
  const window = await openCookingWindow(bot, args, policy, session, context), ms = context.snapshotTimeoutMs ?? 1500;
  const check = () => {
    session.guard(() => {});
    if (bot.version !== '1.21.1' || bot._client?.state !== 'play' || !bot.entity.onGround || bot.health < 12 || assessRisk(survivalSnapshot(bot)).mode !== 'NORMAL' || !farmFootprint(worldReader(bot), bot.entity.position)) fail('cooking_unsafe_body');
    if (!permitsBlock(policy, bot.game?.dimension, args) || readBlock(bot, args)?.name !== 'furnace') fail('cooking_furnace_changed');
    if (bot.currentWindow !== window || window.type !== 'minecraft:furnace' || window.inventoryStart !== 3 || window.inventoryEnd !== 39 || window.slots.length !== 39 || bot.QUICK_BAR_START !== 36) fail('cooking_window_changed');
  };
  check();
  const input = bot.registry.itemsByName[args.item]?.id, output = bot.registry.itemsByName[FURNACE_RECIPES[args.item]]?.id;
  if (!Number.isInteger(input) || !Number.isInteger(output)) fail('cooking_registry_unavailable');
  let before = await snapshot(bot, window, session, ms); check();
  if (window.selectedItem) fail('cooking_cursor_changed');
  const empty = window.slots.findIndex((item, slot) => slot >= 3 && slot < 30 && !item);
  if (empty < 3 || before.slots[empty]) fail('cooking_inventory_full');
  const click = async (slot, button, mode = 0) => {
    check(); if (!Number.isInteger(slot) || slot < 0 || slot >= 30) fail('cooking_click_unavailable');
    await boundedFarm(session.guard(() => bot.clickWindow(slot, button, mode)), session.signal, ms, 'cooking_click_timeout'); check();
  };
  // Each call does one phase. Smelting continues on the server with the GUI
  // closed; a later fresh open recovers output instead of replaying input clicks.
  if (before.slots[2]) {
    const ready = before.slots[2];
    if (ready.type !== output || window.slots[2]?.type !== output || window.slots[2]?.count !== ready.count) fail('cooking_foreign_output');
    await click(2, 0);
    if (window.selectedItem?.type !== output || window.selectedItem.count !== ready.count || window.slots[empty]) fail('cooking_cursor_changed');
    await click(empty, 0);
    const after = await snapshot(bot, window, session, ms); check();
    if (after.slots[2] || count(after, output) - count(before, output) !== ready.count) fail('cooking_output_unconfirmed');
    return { phase: 'collected', item: FURNACE_RECIPES[args.item], count: ready.count, serverInventoryVerified: true, exclusiveCausalityClaimed: false };
  }
  if (before.slots[0] && (before.slots[0].type !== input || before.slots[0].count !== 1)) fail('cooking_foreign_input');
  if (before.slots[1] && !FUEL.some(name => bot.registry.itemsByName[name]?.id === before.slots[1].type)) fail('cooking_foreign_fuel');
  const putOne = async (name, dest) => {
    const type = bot.registry.itemsByName[name]?.id;
    let source = window.slots.findIndex((item, slot) => slot >= 3 && slot < 30 && item?.type === type && item.count > 0);
    if (source < 3) {
      const hotbar = window.slots.slice(30, 39).findIndex(item => item?.type === type && item.count > 0);
      const destination = window.slots.findIndex((item, slot) => slot >= 3 && slot < 30 && !item && !before.slots[slot]);
      if (hotbar < 0 || destination < 3 || before.slots[30 + hotbar]?.type !== type) fail('cooking_ingredient_unavailable');
      const amount = before.slots[30 + hotbar].count;
      await click(destination, hotbar, 2);
      const staged = await snapshot(bot, window, session, ms); check();
      if (staged.slots[destination]?.type !== type || staged.slots[destination].count !== amount || staged.slots[30 + hotbar] || count(staged, type) !== count(before, type)) fail('cooking_staging_unconfirmed');
      before = staged; source = destination;
    }
    if (source < 3 || before.slots[source]?.type !== type || window.slots[source].count !== before.slots[source].count || window.slots[dest]) fail('cooking_ingredient_unavailable');
    const reserveCheck = () => { const reserved = seedReserve(bot); if (dest === 0 && bot.food >= 12 && bot.health > 6 && reserved?.seed === name && count(before, type) <= reserved.count) fail('cooking_seed_reserved'); };
    reserveCheck();
    await click(source, 0);
    if (window.selectedItem?.type !== type) fail('cooking_cursor_changed');
    reserveCheck();
    await click(dest, 1);
    if (window.slots[dest] && (window.slots[dest].type !== type || window.slots[dest].count !== 1)) fail('cooking_input_changed');
    if (dest === 0 && !window.slots[0] && !(window.slots[2]?.type === output && window.slots[2].count === 1)) fail('cooking_input_changed');
    if (window.selectedItem) await click(source, 0);
    if (window.selectedItem) fail('cooking_cursor_changed');
    const after = await snapshot(bot, window, session, ms); check();
    if (count(before, type) - count(after, type) !== 1) fail('cooking_transfer_unconfirmed');
    // Input can already finish; fuel can already be burning. Verify the supplied
    // item either in its slot or its supported processing state, not animation.
    if (dest === 0 && !(after.slots[0]?.type === input && after.slots[0].count === 1) && !(after.slots[2]?.type === output && after.slots[2].count === 1)) fail('cooking_transfer_unconfirmed');
    if (dest === 1) {
      const lit = readBlock(bot, args)?.getProperties?.().lit;
      if (!(after.slots[1]?.type === type && after.slots[1].count === 1) && !(after.slots[1] === null && (lit === true || lit === 'true'))) fail('cooking_transfer_unconfirmed');
    }
    return after;
  };
  if (!before.slots[0]) {
    const reserve = seedReserve(bot);
    if (count(before, input) <= (bot.food >= 12 && reserve?.seed === args.item ? reserve.count : 0)) return { phase: 'idle', cooked: false };
    await putOne(args.item, 0);
    return { phase: 'input_loaded', cooked: false, serverInventoryVerified: true };
  }
  // The furnace block's lit state is server-fed. Existing compatible fuel is
  // left in place; a fuel tick is not misreported as cooked output.
  const lit = readBlock(bot, args)?.getProperties?.().lit;
  if (before.slots[1]) {
    if (!FUEL.some(name => bot.registry.itemsByName[name]?.id === before.slots[1].type)) fail('cooking_foreign_fuel');
    return { phase: 'processing', cooked: false };
  }
  if (lit === true || lit === 'true') return { phase: 'processing', cooked: false };
  const fuel = FUEL.find(name => window.slots.slice(3, 39).some(item => item?.name === name && item.count > 0));
  if (!fuel) fail('cooking_fuel_missing');
  await putOne(fuel, 1);
  return { phase: 'fuel_loaded', cooked: false, serverInventoryVerified: true };
}
