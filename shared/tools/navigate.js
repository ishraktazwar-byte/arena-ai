import { permitsPosition } from '../../src/permissions.js';
import { setTimeout as delay } from 'node:timers/promises';
import { assessRisk, survivalSnapshot } from '../../src/survival.js';
import { executeEscape, safeFootprint, safeSegment, worldReader } from '../../src/escape.js';

const RADIUS = 6, MAX_LEGS = 12, ARRIVAL = 0.25;
const valid = p => p && ['x', 'y', 'z'].every(key => Number.isFinite(p[key]) && Math.abs(p[key]) <= 30000000);
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const key = p => `${Math.floor(p.x)},${Math.floor(p.z)}`;
export class NavigationError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new NavigationError(code); };
function approved(policy, dimension, p) {
  if (!valid(p)) return false;
  return [-0.32, 0.32].every(x => [-0.32, 0.32].every(z => permitsPosition(policy, dimension, { x: p.x + x, y: p.y, z: p.z + z })));
}
function segment(reader, policy, anchor, a, b) {
  if (!approved(policy, anchor.dimension, a) || !approved(policy, anchor.dimension, b) || distance(a, anchor.position) > RADIUS || distance(b, anchor.position) > RADIUS) return false;
  // The authorized box and radius disk are convex: endpoint containment also
  // contains the segment. Terrain is checked along the whole body footprint.
  return safeSegment(reader, a, b);
}
function checkBody(bot, policy, anchor) {
  if (bot.version !== '1.21.1' || bot._client?.state !== 'play') fail('navigation_protocol_unavailable');
  if (bot.entity !== anchor.entity || bot.game?.dimension !== anchor.dimension || !valid(bot.entity?.position)) fail('navigation_body_changed');
  const p = bot.entity.position;
  if (!approved(policy, anchor.dimension, p) || distance(p, anchor.position) > RADIUS) fail('navigation_outside_area');
  if (Math.abs(p.y - anchor.position.y) > 0.05 || !bot.entity.onGround || bot.health < 12 || bot.food < 12 || assessRisk(survivalSnapshot(bot)).mode !== 'NORMAL' || !safeFootprint(worldReader(bot), p)) fail('navigation_unsafe_body');
  if (!Array.isArray(bot.inventory?.slots) || bot.inventory.slots.length < 45 || bot.currentWindow || bot.inventory.selectedItem || bot.inventory.slots.slice(0, 5).some(Boolean)) fail('navigation_inventory_busy');
}

// Breadth-first search of at most 169 same-floor cells. Cache world reads only
// within one synchronous search; movement checks always query current terrain.
export function planLocalRoute(bot, destination, policy, anchor) {
  const position = bot.entity.position;
  const source = { x: Math.floor(position.x) + 0.5, y: anchor.position.y, z: Math.floor(position.z) + 0.5 };
  const cache = new Map(), read = worldReader(bot);
  const reader = p => {
    const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
    if (!cache.has(k)) cache.set(k, read(p));
    return cache.get(k);
  };
  if (!approved(policy, anchor.dimension, destination) || distance(destination, anchor.position) > RADIUS || !safeFootprint(reader, destination)) fail('navigation_destination_unsafe');
  if (!segment(reader, policy, anchor, position, source)) fail('navigation_start_unsafe');
  const queue = [{ point: source, parent: -1 }], seen = new Set([key(source)]);
  let end = -1;
  for (let index = 0; index < queue.length && index < 169; index++) {
    const point = queue[index].point;
    if (key(point) === key(destination)) { end = index; break; }
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const next = { x: point.x + dx, y: point.y, z: point.z + dz };
      const k = key(next);
      if (seen.has(k) || Math.abs(next.x - anchor.position.x) > RADIUS || Math.abs(next.z - anchor.position.z) > RADIUS) continue;
      if (queue.length >= 169 || !segment(reader, policy, anchor, point, next)) continue;
      seen.add(k);
      queue.push({ point: next, parent: index });
    }
  }
  if (end < 0) fail('navigation_no_known_route');
  const route = [];
  while (end >= 0) { route.unshift(queue[end].point); end = queue[end].parent; }
  if (distance(position, route[0]) <= ARRIVAL) route.shift();
  return route;
}

export async function navigateLocal(bot, args, policy, session, {
  now = Date.now, wait = (ms, signal) => delay(ms, undefined, { signal }), move = executeEscape
} = {}) {
  const p = bot.entity?.position;
  if (!valid(p) || !policy?.enabled) fail('navigation_disabled_or_unavailable');
  if (!Number.isInteger(args.x) || !Number.isInteger(args.z) || Math.abs(args.x) > 30000000 || Math.abs(args.z) > 30000000) fail('navigation_invalid_destination');
  const anchor = { entity: bot.entity, dimension: bot.game?.dimension, position: { x: p.x, y: p.y, z: p.z } };
  // No stairs, slabs, jumps or changes of elevation in this initial route skill.
  if (Math.abs(p.y - Math.round(p.y)) > 0.05) fail('navigation_unsupported_floor');
  const destination = { x: args.x + 0.5, y: p.y, z: args.z + 0.5 };
  const stop = () => session.guard(() => bot.clearControlStates());
  const deadline = now() + 14000;
  let legs = 0;
  try {
    checkBody(bot, policy, anchor);
    if (!approved(policy, anchor.dimension, destination) || distance(destination, p) > RADIUS) fail('navigation_destination_outside_area');
    while (distance(bot.entity.position, destination) > ARRIVAL) {
      session.guard(() => {}); checkBody(bot, policy, anchor);
      if (now() >= deadline || legs >= MAX_LEGS) fail('navigation_budget_exhausted');
      const route = planLocalRoute(bot, destination, policy, anchor);
      const next = route[0];
      if (!next || !segment(worldReader(bot), policy, anchor, bot.entity.position, next)) fail('navigation_path_changed');
      stop(); legs++;
      try {
        await move(bot, next, session, { now, wait, durationMs: Math.min(700, deadline - now()), stillNeeded: () => {
          session.guard(() => {}); checkBody(bot, policy, anchor);
          if (now() >= deadline) fail('navigation_budget_exhausted');
          if (!segment(worldReader(bot), policy, anchor, bot.entity.position, next)) fail('navigation_path_changed');
          return true;
        } });
      } catch (error) {
        if (session.signal.aborted || error instanceof NavigationError) throw error;
        fail('navigation_step_failed');
      }
      stop();
    }
    session.guard(() => {}); checkBody(bot, policy, anchor);
    if (now() >= deadline) fail('navigation_budget_exhausted');
    return { destination, legs, arrival: 'local_position_estimate', serverPositionVerified: false, resourceAvailabilityVerified: false };
  } finally { try { stop(); } catch { /* Cleanup after preemption belongs to the new owner. */ } }
}
