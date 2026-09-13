import { setTimeout as delay } from 'node:timers/promises';
import { safeSupport, worldReader } from '../escape.js';
const AIR = new Set(['air', 'cave_air', 'void_air']);
const CROPS = new Set(['wheat', 'carrots', 'potatoes', 'beetroots']);
const valid = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]) && Math.abs(p[k]) <= 30000000);
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export function farmPassable(block) {
  return !!block && (AIR.has(block.name) || (CROPS.has(block.name) && block.boundingBox === 'empty' && Array.isArray(block.shapes) && block.shapes.length === 0));
}
export function farmSurface(read, x, z, level) {
  const soil = read({ x: Math.floor(x), y: level - 1, z: Math.floor(z) });
  if (!farmPassable(read({ x: Math.floor(x), y: level, z: Math.floor(z) })) || !AIR.has(read({ x: Math.floor(x), y: level + 1, z: Math.floor(z) })?.name)) return null;
  if (['farmland', 'dirt_path'].includes(soil?.name)) {
    if (soil.boundingBox !== 'block' || !Array.isArray(soil.shapes) || soil.shapes.length !== 1 || !Array.isArray(soil.shapes[0]) || soil.shapes[0].length !== 6 || !soil.shapes[0].every((v, i) => v === [0, 0, 0, 1, 15 / 16, 1][i])) return null;
    return { x, y: level - 1 / 16, z };
  }
  return safeSupport(soil) ? { x, y: level, z } : null;
}
export function farmFootprint(read, p) {
  if (!valid(p)) return false;
  const level = Math.round(p.y);
  if (Math.abs(p.y - level) > 0.08) return false;
  for (const dx of [-0.32, 0.32]) for (const dz of [-0.32, 0.32]) {
    const surface = farmSurface(read, p.x + dx, p.z + dz, level);
    if (!surface || Math.abs(p.y - surface.y) > 0.08) return false;
  }
  return true;
}
export function farmSegment(read, a, b) {
  if (!valid(a) || !valid(b) || Math.round(a.y) !== Math.round(b.y) || distance(a, b) > 1.6) return false;
  const n = Math.max(1, Math.ceil(distance(a, b) / 0.1));
  for (let i = 0; i <= n; i++) if (!farmFootprint(read, { x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n, z: a.z + (b.z - a.z) * i / n })) return false;
  return true;
}
export function farmGrounded(bot) {
  if (bot.entity?.onGround === true) return true;
  if (bot.entity?.onGround !== false) return false;
  // Permit only the brief 1/16-block settling step, not jumping or real falls.
  const vy = bot.entity?.velocity?.y;
  return Number.isFinite(vy) && vy <= 0 && vy >= -0.15 && farmFootprint(worldReader(bot), bot.entity?.position);
}
export async function executeFarmStep(bot, destination, session, {
  now = Date.now, wait = (ms, signal) => delay(ms, undefined, { signal }), durationMs = 700, stillNeeded = () => true
} = {}) {
  const start = now(), read = worldReader(bot);
  if (!farmGrounded(bot) || !farmSegment(read, bot.entity?.position, destination)) throw new Error('Unsafe farm step');
  const p = bot.entity.position;
  session.guard(() => { bot.setControlState('jump', false); bot.setControlState('sprint', false); });
  await session.guard(() => bot.look(Math.atan2(-(destination.x - p.x), -(destination.z - p.z)), 0, true));
  while (now() >= start && now() - start < durationMs) {
    session.guard(() => {});
    if (!stillNeeded()) return;
    if (!farmGrounded(bot) || !farmSegment(read, bot.entity?.position, destination)) throw new Error('Farm terrain changed');
    if (distance(bot.entity.position, destination) <= 0.2) return;
    session.guard(() => bot.setControlState('forward', true));
    await wait(50, session.signal);
  }
  throw new Error('Farm step timed out');
}
