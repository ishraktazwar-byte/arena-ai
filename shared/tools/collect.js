import { farmFootprint, farmSegment, farmPassable, farmGrounded, executeFarmStep } from '../../src/farming/terrain.js';
import { bindBodySession } from '../../src/control.js';
import { permitsPosition } from '../../src/permissions.js';
import { setTimeout as delay } from 'node:timers/promises';
import { assessRisk, survivalSnapshot } from '../../src/survival.js';
import { worldReader } from '../../src/escape.js';

const MAX_DISTANCE = 4;
const MAX_LEGS = 5;
const PICKUP_DISTANCE = 0.65;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const validPosition = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]) && Math.abs(p[k]) <= 30000000);
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export class CollectionError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new CollectionError(code); };

export function collectionAllowed(policy, dimension, position) {
  return permitsPosition(policy, dimension, position);
}
function approvedFootprint(policy, dimension, position) {
  return [-0.32, 0.32].every(x => [-0.32, 0.32].every(z => collectionAllowed(policy, dimension, { x: position.x + x, y: position.y, z: position.z + z })));
}
function readDrop(bot, entity) {
  if (!entity || !['item', 'Item', 'item_stack'].includes(entity.name) || entity.isValid === false || !Number.isInteger(entity.id) || entity.id < 0 || entity.id > 2147483647 || !UUID.test(entity.uuid || '') || !validPosition(entity.position)) return null;
  let item;
  try { item = entity.getDroppedItem?.(); } catch { return null; }
  if (!item || !/^[a-z0-9_]{1,64}$/.test(item.name || '') || !Number.isInteger(item.count) || item.count < 1 || item.count > 64 || bot.registry?.itemsByName?.[item.name]?.id !== item.type) return null;
  return { entityId: entity.id, entityUuid: entity.uuid.toLowerCase(), item: item.name, itemType: item.type, count: item.count, position: { x: entity.position.x, y: entity.position.y, z: entity.position.z } };
}
function visibleDrop(bot, position) {
  const p = bot.entity?.position;
  if (!p?.offset || !bot.blockAt) return false;
  const eye = p.offset(0, 1.62, 0);
  const end = { x: position.x, y: position.y + 0.12, z: position.z };
  const distance = Math.hypot(end.x - eye.x, end.y - eye.y, end.z - eye.z);
  const steps = Math.max(1, Math.ceil(distance / 0.1));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (!farmPassable(bot.blockAt(eye.offset((end.x - eye.x) * t, (end.y - eye.y) * t, (end.z - eye.z) * t)))) return false;
  }
  return true;
}
function emptyCapacity(bot) {
  // An empty normal inventory slot is conservative even for custom stack NBT.
  // Do not assume equal item names imply two stacks can merge.
  return Array.isArray(bot.inventory?.slots) && bot.inventory.slots.length >= 45 && bot.inventory.slots.slice(9, 45).some(slot => slot == null);
}
function checkBody(bot, policy, anchor) {
  if (bot.version !== '1.21.1' || bot._client?.state !== 'play') fail('collection_protocol_unavailable');
  const p = bot.entity?.position;
  if (bot.entity !== anchor.entity || bot.game?.dimension !== anchor.dimension || !validPosition(p)) fail('collection_body_changed');
  if (!farmGrounded(bot) || bot.health < 12 || bot.food < 12 || assessRisk(survivalSnapshot(bot)).mode !== 'NORMAL' || !farmFootprint(worldReader(bot), p)) fail('collection_unsafe_body');
  if (!approvedFootprint(policy, anchor.dimension, p) || horizontal(p, anchor.position) > MAX_DISTANCE) fail('collection_outside_area');
  if (bot.currentWindow || !Array.isArray(bot.inventory?.slots) || bot.inventory.selectedItem || bot.inventory.slots.slice(0, 5).some(Boolean)) fail('collection_inventory_busy');
}
function checkTarget(bot, args, policy, anchor, original) {
  checkBody(bot, policy, anchor);
  const entity = bot.entities?.[args.entityId];
  const drop = readDrop(bot, entity);
  if (!drop || entity !== original || drop.entityUuid !== args.entityUuid.toLowerCase() || drop.item !== args.expectedItem) fail('collection_target_changed');
  if (Math.abs(drop.position.y - bot.entity.position.y) > 0.6 || horizontal(drop.position, anchor.position) > MAX_DISTANCE) fail('collection_target_out_of_reach');
  if (!collectionAllowed(policy, anchor.dimension, drop.position)) fail('collection_target_outside_area');
  if (!visibleDrop(bot, drop.position)) fail('collection_target_occluded');
  return drop;
}
export function scanItems(bot, policy = { enabled: false }, { expectedItem, eligibleOnly = false } = {}) {
  const result = { enabled: !!policy.enabled, ownership: 'not_observable', items: [] };
  const position = bot.entity?.position;
  if (!validPosition(position)) return result;
  const anchor = { entity: bot.entity, dimension: bot.game?.dimension, position: { x: position.x, y: position.y, z: position.z } };
  // Bound the inspected entity budget and the model-visible result independently.
  for (const entity of Object.values(bot.entities || {}).slice(0, 256)) {
    const drop = readDrop(bot, entity);
    if (!drop || (expectedItem !== undefined && drop.item !== expectedItem) || horizontal(position, drop.position) > MAX_DISTANCE || Math.abs(drop.position.y - position.y) > 0.6 || !visibleDrop(bot, drop.position)) continue;
    let eligible = false, reason = 'collection_disabled';
    if (policy.enabled) {
      try {
        checkTarget(bot, { entityId: drop.entityId, entityUuid: drop.entityUuid, expectedItem: drop.item }, policy, anchor, entity);
        if (!emptyCapacity(bot)) fail('collection_inventory_full');
        eligible = true; reason = 'local_checks_passed';
      } catch (error) { reason = error instanceof CollectionError ? error.code : 'collection_unavailable'; }
    }
    if (eligibleOnly && !eligible) continue;
    result.items.push({ ...drop, distance: horizontal(position, drop.position), eligible, reason });
  }
  result.items.sort((a, b) => a.distance - b.distance || a.entityId - b.entityId);
  result.items = result.items.slice(0, 16);
  return result;
}
function bounded(promise, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new CollectionError('collection_interrupted'));
    const timer = setTimeout(() => finish(new CollectionError('collection_snapshot_timeout')), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(value => finish(null, value), error => finish(error));
  });
}
function stack(raw) {
  if (raw?.itemCount === 0) return null;
  if (!Number.isInteger(raw?.itemId) || raw.itemId < 0 || !Number.isInteger(raw?.itemCount) || raw.itemCount < 1 || raw.itemCount > 64) fail('collection_invalid_inventory_packet');
  return { type: raw.itemId, count: raw.itemCount };
}
async function inventorySnapshot(bot, session, timeoutMs, itemType) {
  if (!bot._syncWindow || !bot._client?.on || !bot._client?.removeListener) fail('collection_confirmation_unavailable');
  let snapshot;
  const onItems = packet => {
    if (packet.windowId !== 0 || !Array.isArray(packet.items)) return;
    try { snapshot = { slots: packet.items.map(stack), cursor: stack(packet.carriedItem) }; } catch { snapshot = null; }
  };
  const cleanup = () => bot._client.removeListener('window_items', onItems);
  session.addCleanup(cleanup);
  bot._client.on('window_items', onItems);
  try {
    await bounded(session.guard(() => bot._syncWindow(bot.inventory)), session.signal, timeoutMs);
    session.guard(() => {});
    if (!snapshot || snapshot.slots.length !== bot.inventory.slots.length || snapshot.slots.length < 45 || snapshot.cursor || snapshot.slots.slice(0, 5).some(Boolean)) fail('collection_inventory_unconfirmed');
    return snapshot.slots.slice(9, 45).reduce((count, item) => count + (item?.type === itemType ? item.count : 0), 0);
  } finally { cleanup(); }
}
function approvedSegment(bot, policy, anchor, start, end) {
  if (!farmSegment(worldReader(bot), start, end)) return false;
  const steps = Math.max(1, Math.ceil(horizontal(start, end) / 0.1));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (!approvedFootprint(policy, anchor.dimension, { x: start.x + (end.x - start.x) * t, y: start.y, z: start.z + (end.z - start.z) * t })) return false;
  }
  return true;
}

// Advisory route preflight for the farm worker. Execution rechecks every leg.
export function collectionRouteKnown(bot, position, policy) {
  const origin = bot.entity?.position;
  if (!validPosition(origin) || !validPosition(position)) return false;
  const anchor = { entity: bot.entity, dimension: bot.game?.dimension, position: { x: origin.x, y: origin.y, z: origin.z } };
  try { checkBody(bot, policy, anchor); } catch { return false; }
  if (horizontal(origin, position) > MAX_DISTANCE) return false;
  let start = { ...anchor.position };
  for (let leg = 0; leg < MAX_LEGS && horizontal(start, position) > PICKUP_DISTANCE; leg++) {
    const distance = horizontal(start, position), length = Math.min(0.8, distance - 0.4);
    const end = { x: start.x + (position.x - start.x) / distance * length, y: start.y, z: start.z + (position.z - start.z) / distance * length };
    if (!approvedSegment(bot, policy, anchor, start, end)) return false;
    start = end;
  }
  return horizontal(start, position) <= PICKUP_DISTANCE;
}

export async function collectItems(bot, args, policy, session, {
  now = Date.now, wait = (ms, signal) => delay(ms, undefined, { signal }), move = executeFarmStep,
  snapshotTimeoutMs = 1500, pickupWaitMs = 1200, motionBudgetMs = 6000
} = {}) {
  const origin = bot.entity?.position;
  const anchor = { entity: bot.entity, dimension: bot.game?.dimension, position: validPosition(origin) ? { x: origin.x, y: origin.y, z: origin.z } : null };
  if (!anchor.position || !policy.enabled) fail('collection_disabled_or_unavailable');
  if (typeof session.addCleanup !== 'function' || !bot._client?.on) fail('collection_control_unavailable');
  const original = bot.entities?.[args.entityId];
  const initial = checkTarget(bot, args, policy, anchor, original);
  if (!emptyCapacity(bot)) fail('collection_inventory_full');
  let pickupCount = 0, otherCollector = false, listening = true;
  const onCollect = packet => {
    if (packet.collectedEntityId !== args.entityId || bot.entity !== anchor.entity || bot.game?.dimension !== anchor.dimension) return;
    const current = bot.entities?.[args.entityId];
    const drop = readDrop(bot, current);
    if (current !== original || !drop || drop.entityUuid !== initial.entityUuid || drop.item !== initial.item || !collectionAllowed(policy, anchor.dimension, drop.position)) return;
    if (!Number.isInteger(packet.pickupItemCount) || packet.pickupItemCount < 1 || packet.pickupItemCount > 64) return;
    if (packet.collectorEntityId !== anchor.entity.id) { otherCollector = true; return; }
    pickupCount += packet.pickupItemCount;
  };
  const cleanup = () => { if (listening) { listening = false; bot._client.removeListener('collect', onCollect); } };
  session.addCleanup(cleanup);
  bot._client.on('collect', onCollect);
  const stop = () => session.guard(() => bot.clearControlStates());
  try {
    const before = await inventorySnapshot(bot, session, snapshotTimeoutMs, initial.itemType);
    if (pickupCount || otherCollector) fail('collection_changed_during_baseline');
    checkTarget(bot, args, policy, anchor, original);
    if (!emptyCapacity(bot)) fail('collection_inventory_full');
    const deadline = now() + motionBudgetMs;
    let legs = 0, nearSince = null;
    while (!pickupCount && now() < deadline) {
      session.guard(() => {});
      if (otherCollector) fail('collection_taken_by_other');
      const drop = checkTarget(bot, args, policy, anchor, original);
      if (!emptyCapacity(bot)) fail('collection_inventory_full');
      const position = bot.entity.position;
      const distance = horizontal(position, drop.position);
      if (distance <= PICKUP_DISTANCE) {
        stop();
        nearSince ??= now();
        if (now() - nearSince >= pickupWaitMs) fail('collection_pickup_not_reported');
        await wait(50, session.signal);
        continue;
      }
      nearSince = null;
      if (legs >= MAX_LEGS) fail('collection_movement_budget_exhausted');
      const length = Math.min(0.8, Math.max(0, distance - 0.4));
      const destination = { x: position.x + (drop.position.x - position.x) / distance * length, y: position.y, z: position.z + (drop.position.z - position.z) / distance * length };
      if (!approvedSegment(bot, policy, anchor, position, destination)) fail('collection_path_unsafe');
      stop();
      legs++;
      await move(bot, destination, session, {
        now, wait, durationMs: Math.min(700, deadline - now()),
        stillNeeded: () => {
          session.guard(() => {}); checkBody(bot, policy, anchor);
          if (otherCollector) fail('collection_taken_by_other');
          if (pickupCount) return false;
          const current = checkTarget(bot, args, policy, anchor, original);
          if (!emptyCapacity(bot)) fail('collection_inventory_full');
          if (!approvedSegment(bot, policy, anchor, bot.entity.position, destination)) fail('collection_path_unsafe');
          return horizontal(current.position, drop.position) <= 0.4;
        }
      });
      stop();
    }
    stop();
    checkBody(bot, policy, anchor);
    if (!pickupCount) fail('collection_pickup_not_reported');
    // A matching collect packet alone is an animation/report, not proof that
    // our inventory gained the item. Require a fresh authoritative snapshot too.
    const after = await inventorySnapshot(bot, session, snapshotTimeoutMs, initial.itemType);
    checkBody(bot, policy, anchor);
    const gain = after - before;
    if (gain <= 0) fail('collection_inventory_gain_unconfirmed');
    return {
      entityId: initial.entityId, entityUuid: initial.entityUuid, item: initial.item,
      serverPickupCount: pickupCount, inventoryGainObserved: gain,
      partialPickup: pickupCount < initial.count, inventoryDeltaMatchesPickup: gain === pickupCount,
      serverInventoryVerified: true, exclusiveCausalityClaimed: false
    };
  } finally {
    cleanup();
    try { stop(); } catch { /* Body cleanup belongs to the new owner after interruption. */ }
  }
}

// Resolve a desired item only at execution time: future drops need not have an
// entity ID in the LLM plan. Selection is not proof of origin or ownership.
export async function collectNearby(bot, args, policy, session, {
  now = Date.now, wait = (ms, signal) => delay(ms, undefined, { signal }), ...collectionOptions
} = {}) {
  session = bindBodySession(bot, session, () => new CollectionError('collection_body_changed'));
  const p = bot.entity?.position;
  if (!validPosition(p) || !policy.enabled) fail('collection_disabled_or_unavailable');
  const itemId = bot.registry?.itemsByName?.[args.expectedItem]?.id;
  if (!Number.isInteger(itemId) || itemId < 0) fail('collection_unknown_item');
  const anchor = { entity: bot.entity, dimension: bot.game?.dimension, position: { x: p.x, y: p.y, z: p.z } };
  const originalGuard = session.guard;
  session = { ...session, guard: fn => originalGuard(() => { checkBody(bot, policy, anchor); return fn(); }) };
  // Fixed scan count also bounds discovery when a wall clock changes. No movement
  // or interaction is issued while waiting for spawn/metadata packets to arrive.
  const started = now();
  for (let attempt = 0; attempt <= 20; attempt++) {
    session.guard(() => {});
    if (!emptyCapacity(bot)) fail('collection_inventory_full');
    if (now() - started < 0 || now() - started > 1000) break;
    const target = scanItems(bot, policy, { expectedItem: args.expectedItem, eligibleOnly: true }).items.find(drop => horizontal(anchor.position, drop.position) <= MAX_DISTANCE);
    if (now() - started < 0 || now() - started > 1000) break;
    if (target) {
      const selected = { entityId: target.entityId, entityUuid: target.entityUuid, expectedItem: args.expectedItem };
      const result = await collectItems(bot, selected, policy, session, { now, wait, ...collectionOptions });
      session.guard(() => {});
      return { ...result, selection: 'nearest_observed_eligible_item', originClaimed: false };
    }
    const remaining = 1000 - (now() - started);
    if (remaining <= 0) break;
    if (attempt < 20) await wait(Math.min(50, remaining), session.signal);
  }
  fail('collection_no_matching_drop');
}
