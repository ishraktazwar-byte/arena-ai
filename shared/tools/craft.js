import { assessRisk, survivalSnapshot } from '../../src/survival.js';
import { safeFootprint, worldReader } from '../../src/escape.js';

export const craftItems = Object.freeze([
  ...['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry'].map(name => `${name}_planks`),
  'stick', 'crafting_table',
  ...['wooden', 'stone'].flatMap(material => ['pickaxe', 'axe', 'shovel', 'sword', 'hoe'].map(tool => `${material}_${tool}`))
]);
export class CraftError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new CraftError(code); };
const stateByBot = new WeakMap();
function stateFor(bot) { if (!stateByBot.has(bot)) stateByBot.set(bot, { recoveryRequired: false }); return stateByBot.get(bot); }
function windowInfo(bot) {
  const window = bot.currentWindow || bot.inventory;
  if (!window || !['minecraft:inventory', 'minecraft:crafting'].includes(window.type)) fail('unsupported_window');
  const width = window.type === 'minecraft:inventory' ? 2 : 3;
  if (!Number.isInteger(window.id) || !Array.isArray(window.slots) || !Number.isInteger(window.inventoryStart) || !Number.isInteger(window.inventoryEnd)) fail('invalid_inventory');
  return { window, width, end: Math.min(window.inventoryEnd, 36) };
}
function cleanGrid(window, width) { return !window.selectedItem && window.slots.slice(0, width * width + 1).every(item => !item); }
function itemMatches(item, ingredient) { return item?.type === ingredient.id && (ingredient.metadata == null || item.metadata === ingredient.metadata); }
function countItems(window) {
  const totals = new Map();
  for (const item of window.slots.slice(window.inventoryStart, window.inventoryEnd)) if (item) totals.set(item.type, (totals.get(item.type) || 0) + item.count);
  return totals;
}
function layout(recipe, width) {
  if (recipe.outShape || recipe.requiresTable && width !== 3) return null;
  const cells = [];
  if (recipe.inShape) {
    if (recipe.ingredients || recipe.inShape.length > width || recipe.inShape.some(row => !Array.isArray(row) || row.length > width)) return null;
    recipe.inShape.forEach((row, y) => row.forEach((ingredient, x) => { if (ingredient.id !== -1) cells.push({ slot: 1 + y * width + x, ingredient }); }));
  } else if (Array.isArray(recipe.ingredients) && recipe.ingredients.length <= width * width) {
    recipe.ingredients.forEach((ingredient, i) => cells.push({ slot: i + 1, ingredient }));
  }
  if (!cells.length || cells.some(c => !Number.isInteger(c.ingredient.id) || Math.abs(c.ingredient.count) !== 1)) return null;
  return cells;
}
export function planCraft(bot, itemName) {
  if (!craftItems.includes(itemName)) fail('unsupported_craft_item');
  const item = bot.registry?.itemsByName?.[itemName];
  if (!item || !bot.recipesAll) fail('recipe_data_unavailable');
  const { window, width, end } = windowInfo(bot);
  if (!cleanGrid(window, width)) fail('crafting_grid_or_cursor_occupied');
  const destination = window.slots.findIndex((slot, i) => i >= window.inventoryStart && i < end && !slot);
  if (destination < 0) fail('no_main_inventory_output_space');
  const recipes = bot.recipesAll(item.id, null, true);
  let tableOnly = false;
  for (const recipe of recipes) {
    if (recipe.result?.id !== item.id || !Number.isInteger(recipe.result.count) || recipe.result.count < 1 || recipe.result.count > 64) continue;
    if (recipe.requiresTable && width !== 3) { tableOnly = true; continue; }
    const cells = layout(recipe, width);
    if (!cells) continue;
    const available = new Map();
    const placements = [];
    const consumed = new Map();
    for (const { slot, ingredient } of cells) {
      let source = -1;
      for (let i = window.inventoryStart; i < end; i++) {
        const stack = window.slots[i];
        if (itemMatches(stack, ingredient) && stack.count - (available.get(i) || 0) > 0) { source = i; break; }
      }
      if (source < 0) break;
      available.set(source, (available.get(source) || 0) + 1);
      consumed.set(ingredient.id, (consumed.get(ingredient.id) || 0) + 1);
      placements.push({ source, slot, ingredient });
    }
    if (placements.length !== cells.length || consumed.has(item.id)) continue;
    return { itemName, itemId: item.id, count: recipe.result.count, window, width, destination, placements, consumed, before: countItems(window) };
  }
  fail(tableOnly && width === 2 ? 'crafting_table_window_required' : 'missing_ingredients_or_unsupported_recipe');
}
export function craftOptions(bot) {
  const options = [];
  for (const name of craftItems) {
    try {
      const plan = planCraft(bot, name);
      options.push({ item: name, outputCount: plan.count, ready: !stateFor(bot).recoveryRequired, reason: stateFor(bot).recoveryRequired ? 'inventory_recovery_required' : 'ingredients_available' });
    } catch (error) {
      if (error.code === 'crafting_table_window_required') options.push({ item: name, ready: false, reason: error.code });
    }
  }
  return { recoveryRequired: stateFor(bot).recoveryRequired, options };
}
function checkBody(bot, window) {
  if (bot.version !== '1.21.1') fail('craft_protocol_unsupported');
  if (!bot.entity?.onGround || bot.health < 12 || bot.food < 12 || assessRisk(survivalSnapshot(bot)).mode !== 'NORMAL' || !safeFootprint(worldReader(bot), bot.entity.position)) fail('unsafe_crafting_body');
  if ((bot.currentWindow || bot.inventory) !== window) fail('crafting_window_changed');
}
function bounded(promise, signal, ms) {
  return new Promise((resolve, reject) => {
    const abort = () => done(new CraftError('craft_interrupted'));
    const timer = setTimeout(() => done(new CraftError('craft_step_timeout')), ms);
    let finished = false;
    function done(error, value) {
      if (finished) return;
      finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    }
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(value => done(null, value), error => done(error));
  });
}
function decode(raw) {
  if (raw?.itemCount === 0) return null;
  if (!Number.isInteger(raw?.itemId) || !Number.isInteger(raw?.itemCount) || raw.itemCount < 1 || raw.itemCount > 64) fail('invalid_inventory_packet');
  return { type: raw.itemId, count: raw.itemCount };
}
// Requests one authoritative whole-window snapshot. The pinned _syncWindow
// sends its no-op resync packet before awaiting; it has no later packet writes.
async function syncSnapshot(bot, window, session, timeoutMs) {
  let snapshot;
  const onItems = packet => {
    if (packet.windowId !== window.id || !Array.isArray(packet.items)) return;
    try { snapshot = { slots: packet.items.map(decode), cursor: decode(packet.carriedItem) }; } catch { snapshot = null; }
  };
  if (!bot._client?.on || !bot._syncWindow) fail('inventory_confirmation_unavailable');
  bot._client.on('window_items', onItems);
  try {
    await bounded(session.guard(() => bot._syncWindow(window)), session.signal, timeoutMs);
    session.guard(() => {});
    if (!snapshot || snapshot.slots.length !== window.slots.length) fail('inventory_confirmation_missing');
    return snapshot;
  } finally { bot._client.removeListener('window_items', onItems); }
}

export async function craftOne(bot, { item }, session, { stepTimeoutMs = 2000 } = {}) {
  const state = stateFor(bot);
  const { window, width } = windowInfo(bot);
  checkBody(bot, window);
  if (!bot._client?.on || !bot._client?.removeListener || !bot._syncWindow || !bot.clickWindow || !bot.closeWindow || !Number.isInteger(bot.QUICK_BAR_START)) fail('craft_api_unavailable');
  if (typeof session.addCleanup !== 'function') fail('cleanup_ownership_unavailable');
  if (state.recoveryRequired) {
    const recovered = await syncSnapshot(bot, window, session, stepTimeoutMs);
    checkBody(bot, window);
    if (recovered.cursor || recovered.slots.slice(0, width * width + 1).some(Boolean)) fail('inventory_recovery_required');
    state.recoveryRequired = false;
  }
  const plan = planCraft(bot, item);
  let touched = false, completed = false;
  session.addCleanup(() => {
    if (!touched) return;
    if (!completed) state.recoveryRequired = true;
    // Synchronous cleanup runs before another action acquires the body. No
    // delayed cleanup clicks, item tossing or stale helper loops are started.
    if (bot.health > 0 && bot._client?.state === 'play' && (bot.currentWindow || bot.inventory) === window) {
      const closed = bot.closeWindow(window);
      if (closed?.catch) void closed.catch(() => { state.recoveryRequired = true; });
    }
  });
  const click = async (slot, button) => {
    session.guard(() => {}); checkBody(bot, window);
    // Mineflayer has an internal await before hotbar clicks. Never enter that
    // branch: all sources/output destinations here are in main slots <36.
    if (!Number.isInteger(bot.QUICK_BAR_START) || slot >= bot.QUICK_BAR_START || slot < 0) fail('unsafe_click_slot');
    touched = true;
    await bounded(session.guard(() => bot.clickWindow(slot, button, 0)), session.signal, stepTimeoutMs);
    session.guard(() => {}); checkBody(bot, window);
  };
  for (const placement of plan.placements) {
    if (window.selectedItem || window.slots[placement.slot] || !itemMatches(window.slots[placement.source], placement.ingredient)) fail('ingredients_changed');
    await click(placement.source, 0);
    if (!itemMatches(window.selectedItem, placement.ingredient)) fail('cursor_mismatch');
    await click(placement.slot, 1);
    if (!itemMatches(window.slots[placement.slot], placement.ingredient) || window.slots[placement.slot].count !== 1) fail('grid_mismatch');
    if (window.selectedItem) await click(placement.source, 0);
    if (window.selectedItem) fail('cursor_not_empty');
  }
  const result = window.slots[0];
  if (result?.type !== plan.itemId || result.count !== plan.count) fail('crafting_result_mismatch');
  // Pick up exactly one result batch; never shift-click and repeat a recipe.
  await click(0, 0);
  if (window.selectedItem?.type !== plan.itemId || window.selectedItem.count !== plan.count) fail('output_cursor_mismatch');
  if (window.slots[plan.destination]) fail('output_destination_changed');
  await click(plan.destination, 0);
  if (window.selectedItem) fail('output_not_stored');
  const confirmed = await syncSnapshot(bot, window, session, stepTimeoutMs);
  checkBody(bot, window);
  const counts = new Map();
  for (const stack of confirmed.slots.slice(window.inventoryStart, window.inventoryEnd)) if (stack) counts.set(stack.type, (counts.get(stack.type) || 0) + stack.count);
  if (confirmed.cursor || confirmed.slots.slice(0, width * width + 1).some(Boolean) || (counts.get(plan.itemId) || 0) - (plan.before.get(plan.itemId) || 0) !== plan.count) fail('output_inventory_unconfirmed');
  for (const [type, used] of plan.consumed) if ((plan.before.get(type) || 0) - (counts.get(type) || 0) !== used) fail('ingredient_consumption_unconfirmed');
  completed = true;
  return { item, batches: 1, outputCountObserved: plan.count, serverInventoryVerified: true, exclusiveCausalityClaimed: false };
}
