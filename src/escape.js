import { setTimeout as delay } from 'node:timers/promises';

const AIR = new Set(['air', 'cave_air', 'void_air']);
const UNSAFE_SUPPORT = new Set(['magma_block', 'cactus', 'campfire', 'soul_campfire', 'powder_snow', 'ice', 'packed_ice', 'blue_ice', 'slime_block', 'honey_block', 'sand', 'red_sand', 'gravel']);
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const valid = p => p && [p.x, p.y, p.z].every(Number.isFinite);

// Inspect the player's footprint plus a small margin, not just its center.
export function safeSupport(block) {
  return !!block && !UNSAFE_SUPPORT.has(block.name) && block.boundingBox === 'block' && Array.isArray(block.shapes) && block.shapes.some(shape => Array.isArray(shape) && shape.length === 6 && shape.every((v, i) => v === (i < 3 ? 0 : 1)));
}

export function safeFootprint(blockAt, point) {
  if (!valid(point)) return false;
  for (const dx of [-0.32, 0.32]) for (const dz of [-0.32, 0.32]) {
    const x = Math.floor(point.x + dx), y = Math.floor(point.y), z = Math.floor(point.z + dz);
    const feet = blockAt({ x, y, z });
    const head = blockAt({ x, y: y + 1, z });
    const support = blockAt({ x, y: y - 1, z });
    if (!feet || !head || !support || !AIR.has(feet.name) || !AIR.has(head.name)) return false;
    if (UNSAFE_SUPPORT.has(support.name) || support.boundingBox !== 'block') return false;
    if (!support.shapes?.some(shape => shape.length === 6 && shape.every((v, i) => v === (i < 3 ? 0 : 1)))) return false;
  }
  return true;
}

export function safeSegment(blockAt, start, end) {
  if (!valid(start) || !valid(end) || Math.abs(start.y - end.y) > 0.1 || distance(start, end) > 1.6) return false;
  const steps = Math.max(1, Math.ceil(distance(start, end) / 0.15));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (!safeFootprint(blockAt, { x: start.x + (end.x - start.x) * t, y: start.y, z: start.z + (end.z - start.z) * t })) return false;
  }
  return true;
}

function separation(point, threats) {
  return Math.min(...threats.map(threat => distance(point, threat.position)));
}

export function planEscape({ position, onGround, blockAt, threats }) {
  if (!valid(position) || !onGround || !safeFootprint(blockAt, position)) return { state: 'BLOCKED', reason: 'unsupported_start' };
  const relevant = threats.filter(t => valid(t.position) && Math.abs(t.position.y - position.y) <= 4);
  if (!relevant.length) return { state: 'BLOCKED', reason: 'no_relevant_threat' };
  const initial = separation(position, relevant);
  const candidates = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: position.x + dx, y: position.y, z: position.z + dz }));
  const choices = candidates.filter(end => safeSegment(blockAt, position, end)).map(end => ({ end, gain: separation(end, relevant) - initial }));
  choices.sort((a, b) => b.gain - a.gain);
  if (!choices.length || choices[0].gain < 0.2) return { state: 'BLOCKED', reason: 'no_safer_known_step' };
  return { state: 'PLANNED', destination: choices[0].end, gain: choices[0].gain };
}

export function worldReader(bot) {
  return point => {
    const origin = bot.entity?.position;
    return origin && bot.blockAt ? bot.blockAt(origin.offset(point.x - origin.x, point.y - origin.y, point.z - origin.z)) : null;
  };
}

// One short, ground-only segment. Never jumps, digs, crosses unknown terrain,
// or blindly repeats an old path. Arbiter cleanup releases controls on all exits.
export async function executeEscape(bot, destination, { guard, signal }, {
  now = Date.now, wait = (ms, signal) => delay(ms, undefined, { signal }), durationMs = 700,
  stillNeeded = () => true
} = {}) {
  const started = now();
  const blockAt = worldReader(bot);
  const origin = bot.entity?.position;
  if (!origin || !bot.entity.onGround || !safeSegment(blockAt, origin, destination)) throw new Error('Escape geometry invalid');
  const yaw = Math.atan2(-(destination.x - origin.x), -(destination.z - origin.z));
  await guard(() => bot.look(yaw, 0, true));
  while (now() - started < durationMs) {
    guard(() => {});
    const position = bot.entity?.position;
    if (!stillNeeded()) return { response: 'risk_reduced' };
    if (!position || !bot.entity.onGround || !safeSegment(blockAt, position, destination)) throw new Error('Escape geometry changed');
    if (distance(position, destination) <= 0.2) return { response: 'reached_step' };
    guard(() => bot.setControlState('forward', true));
    await wait(50, signal);
  }
  throw new Error('Escape step timed out');
}
