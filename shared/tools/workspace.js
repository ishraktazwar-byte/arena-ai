import { assessRisk, survivalSnapshot } from '../../src/survival.js';
import { safeFootprint, safeSegment, worldReader } from '../../src/escape.js';
import { readBlock, isAir, sameBlock } from './resources.js';
import { craftOne } from './craft.js';

export class WorkspaceError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new WorkspaceError(code); };
const SUPPORT = new Set(['stone', 'deepslate', 'andesite', 'diorite', 'granite', 'dirt', 'grass_block', 'coarse_dirt', 'podzol', 'mycelium', 'cobblestone', 'mossy_cobblestone']);
const coordinators = new WeakMap();
export function workspaceAllowed(policy, dimension, p) {
  const a = policy?.area;
  return policy?.enabled === true && a && dimension === policy.dimension && p.x >= a.minX && p.x <= a.maxX && p.y >= a.minY && p.y <= a.maxY && p.z >= a.minZ && p.z <= a.maxZ;
}
function checkBody(bot) {
  if (bot.version !== '1.21.1' || bot._client?.state !== 'play') fail('workspace_protocol_unavailable');
  if (!bot.entity?.onGround || bot.health < 12 || bot.food < 12 || assessRisk(survivalSnapshot(bot)).mode !== 'NORMAL' || !safeFootprint(worldReader(bot), bot.entity.position)) fail('unsafe_workspace_body');
  if (coordinators.get(bot)?.quarantined) fail('workspace_reconnect_required');
}
function clearInventory(bot) {
  if (bot.currentWindow || !bot.inventory?.slots || bot.inventory.selectedItem || bot.inventory.slots.slice(0, 5).some(Boolean)) fail('workspace_inventory_busy');
}
function topFaceVisible(bot, block) {
  if (!block?.position?.offset) return false;
  const eye = bot.entity.position.offset(0, 1.62, 0);
  const point = block.position.offset(0.5, 0.999, 0.5);
  const distance = eye.distanceTo(point);
  if (distance > 4) return false;
  const steps = Math.max(1, Math.ceil(distance / 0.08));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const sample = bot.blockAt(eye.offset((point.x - eye.x) * t, (point.y - eye.y) * t, (point.z - eye.z) * t));
    if (!sample) return false;
    if (sameBlock(sample.position, block.position)) return true;
    if (!isAir(sample)) return false;
  }
  return false;
}
export function checkTable(bot, p, policy, stateId) {
  checkBody(bot);
  if (!workspaceAllowed(policy, bot.game?.dimension, p)) fail('outside_workspace_permission');
  if (p.y !== Math.floor(bot.entity.position.y)) fail('workspace_elevation_unsupported');
  const block = readBlock(bot, p);
  if (block?.name !== 'crafting_table' || stateId !== undefined && block.stateId !== stateId) fail('workspace_table_changed');
  if (!topFaceVisible(bot, block)) fail('workspace_table_not_visible');
  return block;
}
export function checkPlacement(bot, p, policy, supportState) {
  checkBody(bot); clearInventory(bot);
  if (!workspaceAllowed(policy, bot.game?.dimension, p)) fail('outside_workspace_permission');
  const origin = bot.entity.position;
  if (p.y !== Math.floor(origin.y)) fail('workspace_elevation_unsupported');
  if (!isAir(readBlock(bot, p)) || !isAir(readBlock(bot, { ...p, y: p.y + 1 }))) fail('workspace_destination_occupied');
  if (p.x + 1 > origin.x - 0.32 && p.x < origin.x + 0.32 && p.z + 1 > origin.z - 0.32 && p.z < origin.z + 0.32) fail('workspace_body_overlap');
  for (const entity of Object.values(bot.entities || {})) {
    if (entity === bot.entity || !entity.position || entity.isValid === false) continue;
    const e = entity.position, half = (entity.width || 0.6) / 2;
    if (e.x + half > p.x && e.x - half < p.x + 1 && e.z + half > p.z && e.z - half < p.z + 1 && e.y + (entity.height || 1.8) > p.y && e.y < p.y + 1) fail('workspace_entity_overlap');
  }
  const support = readBlock(bot, { ...p, y: p.y - 1 });
  if (!support || !SUPPORT.has(support.name) || !support.shapes?.some(shape => shape.length === 6 && shape.every((n, i) => n === (i < 3 ? 0 : 1))) || supportState !== undefined && support.stateId !== supportState) fail('workspace_support_unsafe');
  if ([true, 'true'].includes(support.getProperties?.().waterlogged)) fail('workspace_support_unsafe');
  if (!topFaceVisible(bot, support)) fail('workspace_support_not_visible');
  // Do not place into the only known level-ground escape step.
  const reader = worldReader(bot);
  const afterPlacement = point => sameBlock({ x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) }, p) ? { name: 'crafting_table', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : reader(point);
  if (![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => safeSegment(afterPlacement, origin, { x: origin.x + x, y: origin.y, z: origin.z + z }))) fail('workspace_blocks_known_exit');
  return support;
}
export function inspectWorkspaces(bot, policy = { enabled: false }) {
  const result = { enabled: !!policy.enabled, reconnectRequired: !!coordinators.get(bot)?.quarantined, tables: [], placementSites: [] };
  const origin = bot.entity?.position;
  if (!origin?.offset || !bot.blockAt) return result;
  const x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
    const p = { x: x + dx, y, z: z + dz };
    const block = readBlock(bot, p);
    if (block?.name === 'crafting_table' && topFaceVisible(bot, block)) result.tables.push({ position: p, approved: !!workspaceAllowed(policy, bot.game?.dimension, p) });
  }
  result.tables = result.tables.slice(0, 8);
  if (policy.enabled) for (const [dx, dz] of [[1, 0], [2, 0], [-1, 0], [-2, 0], [0, 1], [0, 2], [0, -1], [0, -2]]) {
    const p = { x: x + dx, y, z: z + dz };
    try { checkPlacement(bot, p, policy); result.placementSites.push(p); } catch { /* Only advertise passing candidates. */ }
  }
  return result;
}
function waitBounded(promise, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const abort = () => finish(new WorkspaceError('workspace_interrupted'));
    const timer = setTimeout(() => finish(new WorkspaceError('workspace_response_timeout')), timeoutMs);
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(value => finish(null, value), error => finish(error));
  });
}
// Exact 1.21.1 packet used by the pinned Mineflayer helpers, without their
// internal async-look gap. Sequence 0 matches those helpers. No generated packet
// fields, arbitrary item types or general-purpose raw-packet tool are exposed.
export function sendTopInteraction(bot, block, session) {
  if (bot.version !== '1.21.1' || bot._client?.state !== 'play') fail('workspace_protocol_unavailable');
  return session.guard(() => bot._client.write('block_place', {
    hand: 0, location: block.position, direction: 1,
    cursorX: 0.5, cursorY: 1, cursorZ: 0.5, insideBlock: false, sequence: 0
  }));
}
function emptyHotbar(bot) {
  if (!bot.setQuickBarSlot || bot.QUICK_BAR_START !== 36) fail('workspace_inventory_api_unavailable');
  for (let i = 0; i < 9; i++) if (!bot.inventory.slots[36 + i]) return i;
  fail('workspace_empty_hotbar_required');
}
async function stageTable(bot, session, timeoutMs) {
  if (bot.heldItem?.name === 'crafting_table' && bot.heldItem.count > 0) return;
  if (!bot._syncWindow || !bot.clickWindow || !bot.setQuickBarSlot || bot.QUICK_BAR_START !== 36) fail('workspace_inventory_api_unavailable');
  let synced = false;
  const onSync = packet => { if (packet.windowId === 0 && Array.isArray(packet.items)) synced = true; };
  bot._client.on('window_items', onSync);
  try { await waitBounded(session.guard(() => bot._syncWindow(bot.inventory)), session.signal, timeoutMs); }
  finally { bot._client.removeListener('window_items', onSync); }
  session.guard(() => {}); checkBody(bot); clearInventory(bot);
  if (!synced) fail('workspace_inventory_unconfirmed');
  const item = bot.inventory.items().find(item => item.name === 'crafting_table' && item.count > 0);
  if (!item || !Number.isInteger(item.slot) || item.slot < 9 || item.slot > 44) fail('workspace_table_item_missing');
  if (item.slot >= 36) { session.guard(() => bot.setQuickBarSlot(item.slot - 36)); return; }
  const hotbar = emptyHotbar(bot);
  // Number-key swap from a main slot executes its write before any await in the
  // pinned click helper. Empty destination means no cursor or displaced stack.
  await waitBounded(session.guard(() => bot.clickWindow(item.slot, hotbar, 2)), session.signal, timeoutMs);
  session.guard(() => {}); checkBody(bot); clearInventory(bot);
  if (bot.inventory.slots[36 + hotbar]?.name !== 'crafting_table') fail('workspace_table_staging_failed');
  session.guard(() => bot.setQuickBarSlot(hotbar));
}
function tableItemCount(bot) { return (bot.inventory?.items() || []).filter(item => item.name === 'crafting_table').reduce((total, item) => total + item.count, 0); }
export async function placeTable(bot, p, policy, session, { responseTimeoutMs = 2000 } = {}) {
  let support = checkPlacement(bot, p, policy);
  const supportState = support.stateId;
  const item = bot.inventory.items().find(item => item.name === 'crafting_table' && item.count > 0);
  if (!item) fail('workspace_table_item_missing');
  await stageTable(bot, session, responseTimeoutMs);
  session.guard(() => {}); support = checkPlacement(bot, p, policy, supportState);
  await waitBounded(session.guard(() => bot.lookAt(support.position.offset(0.5, 1, 0.5), true)), session.signal, responseTimeoutMs);
  session.guard(() => {}); support = checkPlacement(bot, p, policy, supportState);
  if (bot.heldItem?.name !== 'crafting_table' || bot.heldItem.count < 1) fail('workspace_equipment_changed');
  const before = tableItemCount(bot);
  let sent = false, resolve;
  const response = new Promise(r => { resolve = r; });
  const onBlock = packet => {
    if (sent && sameBlock(packet.location, p) && bot.registry?.blocksByStateId?.[packet.type]?.name === 'crafting_table') resolve();
  };
  bot._client.on('block_change', onBlock);
  try {
    sent = true;
    sendTopInteraction(bot, support, session);
    await waitBounded(response, session.signal, responseTimeoutMs);
    session.guard(() => {});
    checkBody(bot);
    if (!workspaceAllowed(policy, bot.game?.dimension, p)) fail('outside_workspace_permission');
    return { position: { x: p.x, y: p.y, z: p.z }, serverTableObserved: true, tableItemsBefore: before, tableItemsAfter: tableItemCount(bot), exclusiveCausalityClaimed: false };
  } finally { bot._client.removeListener('block_change', onBlock); }
}

// One coordinator per live bot. Minecraft's open-window response has no request
// correlation ID. An interrupted in-flight open therefore quarantines new opens
// until reconnect, rather than attaching a late response to a later craft.
class TableWindows {
  constructor(bot, arbiter, emit) {
    Object.assign(this, { bot, arbiter, emit });
    this.pending = null;
    this.quarantined = false;
    this.closed = false;
    this.closingWindow = false;
    this.onPacket = packet => {
      if (this.pending?.sent && !this.pending.window && !this.quarantined) {
        if (this.pending.packetId === null) this.pending.packetId = packet.windowId;
        else { this.pending.ambiguous = true; this.pending.reject(new WorkspaceError('workspace_ambiguous_window')); }
      }
    };
    this.onWindow = window => {
      queueMicrotask(() => {
        if (this.closed) return;
        if (this.quarantined) { this.closeStale(window); return; }
        const pending = this.pending;
        if (!pending?.sent || pending.window || pending.ambiguous) return;
        try {
          pending.session.guard(() => {});
          if (!Number.isInteger(window.id) || window.id <= 0 || pending.packetId !== window.id || window.type !== 'minecraft:crafting' || this.bot.currentWindow !== window) fail('workspace_unexpected_window');
          pending.window = window;
          pending.resolve(window);
        } catch (error) { pending.reject(error); }
      });
    };
    this.onSpawn = () => { if (this.quarantined && bot.currentWindow) this.closeStale(bot.currentWindow); };
    this.onPhysics = () => { if (this.quarantined && !this.closingWindow && bot.currentWindow) this.closeStale(bot.currentWindow); };
    this.onEnd = () => this.dispose();
    bot._client.on('open_window', this.onPacket);
    bot.on('windowOpen', this.onWindow);
    bot.on('spawn', this.onSpawn);
    bot.on('physicsTick', this.onPhysics);
    bot.on('end', this.onEnd);
  }
  closeStale(window) {
    if (this.closed || this.closingWindow || !(this.bot.health > 0) || this.bot._client.state !== 'play' || this.bot.currentWindow !== window) return;
    this.closingWindow = true;
    // This is a new survival-owned action, never a late callback retaining old
    // strategy control. It briefly preempts escape if required, then releases.
    void this.arbiter.run('window-safety', 2000, async ({ guard }) => {
      if (this.bot.currentWindow === window) await guard(() => this.bot.closeWindow(window));
    }, 1000).then(result => this.emit({ type: 'WORKSPACE-WINDOW-SAFETY', state: result.state })).catch(() => this.emit({ type: 'WORKSPACE-WINDOW-SAFETY', state: 'FAILED' })).finally(() => {
      this.closingWindow = false;
      if (!this.closed && this.quarantined && this.bot.currentWindow && this.bot.currentWindow !== window) this.closeStale(this.bot.currentWindow);
    });
  }
  begin(session) {
    if (this.quarantined || this.closed) fail('workspace_reconnect_required');
    if (this.pending) fail('workspace_open_already_pending');
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const pending = { session, sent: false, packetId: null, window: null, resolve, reject, promise };
    this.pending = pending;
    session.addCleanup(() => {
      if (this.pending !== pending) return;
      if (pending.sent && !pending.window) {
        this.quarantined = true;
        this.emit({ type: 'WORKSPACE-QUARANTINE', reason: 'unresolved_open_response' });
      }
      if (pending.window && this.bot.currentWindow === pending.window && this.bot.health > 0 && this.bot._client.state === 'play') {
        try {
          const closed = this.bot.closeWindow(pending.window);
          if (closed?.catch) void closed.catch(() => { this.quarantined = true; });
        } catch { this.quarantined = true; }
      } else if (this.quarantined && this.bot.currentWindow) {
        const stale = this.bot.currentWindow;
        queueMicrotask(() => { if (!this.closed) this.closeStale(stale); });
      }
      this.pending = null;
    });
    return pending;
  }
  dispose() {
    this.closed = true;
    this.bot._client.removeListener('open_window', this.onPacket);
    this.bot.removeListener('windowOpen', this.onWindow);
    this.bot.removeListener('spawn', this.onSpawn);
    this.bot.removeListener('physicsTick', this.onPhysics);
    this.bot.removeListener('end', this.onEnd);
  }
}
function getCoordinator(bot, arbiter, emit) {
  let manager = coordinators.get(bot);
  if (!manager) { manager = new TableWindows(bot, arbiter, emit); coordinators.set(bot, manager); }
  return manager;
}
export async function craftAtTable(bot, args, policy, session, { arbiter, emit = () => {}, responseTimeoutMs = 2500, craft = craftOne } = {}) {
  let table = checkTable(bot, args, policy);
  clearInventory(bot);
  if (!arbiter || typeof session.addCleanup !== 'function' || !bot.closeWindow) fail('workspace_control_unavailable');
  const stateId = table.stateId;
  // Empty main hand: if the table disappears before server processing, this
  // interaction cannot accidentally place the previously held block.
  if (bot.heldItem) { const empty = emptyHotbar(bot); session.guard(() => bot.setQuickBarSlot(empty)); }
  session.guard(() => {}); clearInventory(bot); table = checkTable(bot, args, policy, stateId);
  await waitBounded(session.guard(() => bot.lookAt(table.position.offset(0.5, 1, 0.5), true)), session.signal, responseTimeoutMs);
  session.guard(() => {}); clearInventory(bot); table = checkTable(bot, args, policy, stateId);
  if (bot.heldItem) fail('workspace_hand_not_empty');
  const manager = getCoordinator(bot, arbiter, emit);
  const pending = manager.begin(session);
  pending.sent = true;
  sendTopInteraction(bot, table, session);
  const window = await waitBounded(pending.promise, session.signal, responseTimeoutMs);
  session.guard(() => {}); checkTable(bot, args, policy, stateId);
  if (window !== bot.currentWindow) fail('workspace_window_changed');
  const result = await craft(bot, { item: args.item }, session);
  session.guard(() => {});
  return { tablePosition: { x: args.x, y: args.y, z: args.z }, ...result };
}
