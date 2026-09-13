const providers = new WeakMap();
export function attachSeedReserve(bot, get) { providers.set(bot, get); }
export function seedReserve(bot) { return providers.get(bot)?.() || null; }
export function foodReserves(bot) { const reserve = seedReserve(bot); return reserve ? { [reserve.seed]: reserve.count } : {}; }
export function mayPlantSeed(bot, seed, cell) {
  const reserve = seedReserve(bot);
  if (!reserve || reserve.seed !== seed) return true;
  if (cell.y === reserve.y && Math.abs(cell.x - reserve.x) <= 2 && Math.abs(cell.z - reserve.z) <= 2) return true;
  const count = bot.inventory.slots.slice(9, 45).reduce((n, item) => n + (item?.name === seed && Number.isInteger(item.count) ? item.count : 0), 0);
  return count > reserve.count;
}
