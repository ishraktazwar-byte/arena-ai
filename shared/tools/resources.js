const LOGS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry'].map(name => `${name}_log`);
const ORES = ['coal', 'iron', 'copper', 'gold', 'redstone', 'lapis', 'diamond', 'emerald'].flatMap(name => [`${name}_ore`, `deepslate_${name}_ore`]);
export const resourceNames = new Set([...LOGS, ...ORES, 'stone', 'deepslate', 'granite', 'diorite', 'andesite']);
export const isLog = name => LOGS.includes(name);
export const sameBlock = (a, b) => a && b && a.x === b.x && a.y === b.y && a.z === b.z;
export const isAir = block => block && ['air', 'cave_air', 'void_air'].includes(block.name);
export function blockVector(bot, p) {
  const origin = bot.entity?.position;
  return origin?.offset ? origin.offset(p.x - origin.x, p.y - origin.y, p.z - origin.z) : null;
}
export function readBlock(bot, p) {
  const v = blockVector(bot, p);
  return v && bot.blockAt ? bot.blockAt(v) : null;
}
export function visibleResource(bot, block, { passable = isAir } = {}) {
  const position = bot.entity?.position;
  if (!position?.offset || !block?.position) return false;
  const eye = position.offset(0, 1.62, 0);
  const center = block.position.offset(0.5, 0.5, 0.5);
  const length = eye.distanceTo(center);
  if (length > 4) return false;
  const steps = Math.max(1, Math.ceil(length / 0.08));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const point = eye.offset((center.x - eye.x) * t, (center.y - eye.y) * t, (center.z - eye.z) * t);
    const seen = bot.blockAt(point);
    if (!seen) return false;
    if (sameBlock(seen.position, block.position)) return true;
    if (!passable(seen)) return false;
  }
  return false;
}
export function scanResources(bot) {
  const p = bot.entity?.position;
  if (!p?.offset || !bot.blockAt) return [];
  const found = [];
  // Fixed 9x7x9 search budget; no hidden-block knowledge enters the result.
  for (let dx = -4; dx <= 4; dx++) for (let dy = -2; dy <= 4; dy++) for (let dz = -4; dz <= 4; dz++) {
    const block = readBlock(bot, { x: Math.floor(p.x) + dx, y: Math.floor(p.y) + dy, z: Math.floor(p.z) + dz });
    if (!resourceNames.has(block?.name) || !visibleResource(bot, block)) continue;
    found.push({ name: block.name, position: { x: block.position.x, y: block.position.y, z: block.position.z }, distance: p.distanceTo(block.position.offset(0.5, 0.5, 0.5)), visibility: 'line_of_sight_sampled' });
  }
  return found.sort((a, b) => a.distance - b.distance).slice(0, 16);
}
