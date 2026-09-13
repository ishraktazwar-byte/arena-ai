import { bindBodySession } from '../../src/control.js';
import { permitsBlock } from '../../src/permissions.js';
import { farmPassable, farmSegment } from '../../src/farming/terrain.js';
import { safeSupport, worldReader } from '../../src/escape.js';
import { readBlock, sameBlock, isAir } from './resources.js';
import { FarmingError, checkFarmBody, boundedFarm } from './farm.js';
import { playerSnapshot, stageCarriedItem } from './plant.js';
export const TILLABLE = new Set(['dirt', 'grass_block', 'coarse_dirt', 'dirt_path']);
export const FARM_BLOCKS = Object.freeze(['cobblestone', 'crafting_table', 'furnace', 'torch']);
const WALLS = new Set(['dirt', 'grass_block', 'coarse_dirt', 'stone', 'cobblestone', 'deepslate', 'andesite', 'diorite', 'granite']);
const directions = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];
const fail = code => { throw new FarmingError(code); };
export function waterSource(block) { return block?.name === 'water' && String(block.getProperties?.().level) === '0'; }
export function farmRay(bot, block, { height = 0.999, fluid = false } = {}) {
  if (!block?.position?.offset) return false;
  const eyeHeight = bot.entity?.eyeHeight ?? 1.62;
  if (!Number.isFinite(eyeHeight) || eyeHeight < 1 || eyeHeight > 2) return false;
  const eye = bot.entity.position.offset(0, eyeHeight, 0), end = block.position.offset(0.5, height, 0.5);
  const distance = eye.distanceTo(end), n = Math.ceil(distance / 0.04);
  if (!Number.isFinite(distance) || distance > 4 || !n) return false;
  if (fluid) {
    // Exact voxel intervals: fixed-distance samples can skip a thin rim corner
    // and make a bucket hit the bank instead of the sealed pocket bottom.
    const cuts = [0, 1];
    for (const axis of ['x', 'y', 'z']) {
      const delta = end[axis] - eye[axis]; if (!delta) continue;
      for (let plane = Math.floor(Math.min(eye[axis], end[axis])) + 1; plane <= Math.ceil(Math.max(eye[axis], end[axis])); plane++) {
        const t = (plane - eye[axis]) / delta; if (t > 0 && t < 1) cuts.push(t);
      }
    }
    cuts.sort((a, b) => a - b);
    for (let i = 1; i < cuts.length; i++) {
      if (cuts[i] === cuts[i - 1]) continue;
      const t = (cuts[i] + cuts[i - 1]) / 2;
      const at = bot.blockAt(eye.offset((end.x - eye.x) * t, (end.y - eye.y) * t, (end.z - eye.z) * t));
      if (!at) return false;
      if (sameBlock(at.position, block.position)) return true;
      if (!isAir(at)) return false;
    }
    return false;
  }
  for (let i = 0; i <= n; i++) {
    const at = bot.blockAt(eye.offset((end.x - eye.x) * i / n, (end.y - eye.y) * i / n, (end.z - eye.z) * i / n));
    if (!at) return false;
    if (sameBlock(at.position, block.position)) return true;
    if (!(fluid ? isAir(at) : farmPassable(at))) return false;
  }
  return false;
}
export function developmentBody(bot, p, policy) {
  checkFarmBody(bot);
  if (!permitsBlock(policy, bot.game?.dimension, p)) fail('development_permission');
  const origin = bot.entity.position;
  if (Math.abs(p.y - Math.round(origin.y)) > 2) fail('development_elevation');
  if (p.x + 1 > origin.x - 0.32 && p.x < origin.x + 0.32 && p.z + 1 > origin.z - 0.32 && p.z < origin.z + 0.32) fail('development_body_column');
  for (const entity of Object.values(bot.entities || {}).slice(0, 256)) {
    if (entity === bot.entity || !entity.position || entity.isValid === false || ['item', 'Item', 'item_stack'].includes(entity.name)) continue;
    const e = entity.position, radius = (entity.width || 0.6) / 2;
    if (e.x + radius > p.x && e.x - radius < p.x + 1 && e.z + radius > p.z && e.z - radius < p.z + 1 && e.y + (entity.height || 1.8) > p.y && e.y < p.y + 1) fail('development_entity_overlap');
  }
}
export function checkTilling(bot, p, policy) {
  developmentBody(bot, p, policy);
  const block = readBlock(bot, p);
  if (!TILLABLE.has(block?.name) || !isAir(readBlock(bot, { ...p, y: p.y + 1 })) || !safeSupport(readBlock(bot, { ...p, y: p.y - 1 }))) fail('soil_not_tillable');
  if (!farmRay(bot, block)) fail('development_unreachable');
  return block;
}
export function checkBasin(bot, p, policy, { dug = false, filled = false, verifyRay = true } = {}) {
  developmentBody(bot, p, policy);
  if (bot.game.dimension === 'the_nether') fail('water_evaporates');
  const target = readBlock(bot, p);
  if (filled ? !waterSource(target) : dug ? !isAir(target) : !['dirt', 'grass_block', 'coarse_dirt'].includes(target?.name)) fail('basin_target_changed');
  if (!isAir(readBlock(bot, { ...p, y: p.y + 1 }))) fail('basin_covered');
  for (const [x, y, z] of directions) {
    const wall = readBlock(bot, { x: p.x + x, y: p.y + y, z: p.z + z });
    if (!WALLS.has(wall?.name) || !safeSupport(wall) || ['true', true].includes(wall.getProperties?.().waterlogged)) fail('basin_not_contained');
  }
  const aim = dug ? readBlock(bot, { ...p, y: p.y - 1 }) : target;
  if (verifyRay && !farmRay(bot, aim, { fluid: true })) fail('development_unreachable');
  return aim;
}
export function checkWaterSource(bot, p, policy, removed = false) {
  developmentBody(bot, p, policy);
  const block = readBlock(bot, p);
  if (!removed && !waterSource(block)) fail('water_source_required');
  if (!isAir(readBlock(bot, { ...p, y: p.y + 1 }))) fail('water_source_covered');
  const below = readBlock(bot, { ...p, y: p.y - 1 });
  if (!safeSupport(below) && !waterSource(below)) fail('water_source_not_renewable');
  if (directions.slice(0, 4).filter(([x, y, z]) => waterSource(readBlock(bot, { x: p.x + x, y: p.y + y, z: p.z + z }))).length < 2) fail('water_source_not_renewable');
  if (!removed && !farmRay(bot, block, { height: 0.85, fluid: true })) fail('development_unreachable');
  return block;
}
export function checkFarmPlacement(bot, p, policy, name) {
  developmentBody(bot, p, policy);
  if (!FARM_BLOCKS.includes(name) || !isAir(readBlock(bot, p))) fail('development_cell_occupied');
  const support = readBlock(bot, { ...p, y: p.y - 1 });
  const farmland = support?.name === 'farmland' && support.shapes?.[0]?.join(',') === '0,0,0,1,0.9375,1';
  if ((!WALLS.has(support?.name) || !safeSupport(support)) && !(farmland && name !== 'torch')) fail('development_support');
  if (farmland && !permitsBlock(policy, bot.game?.dimension, support.position)) fail('development_permission');
  if (['true', true].includes(support.getProperties?.().waterlogged)) fail('development_support');
  if (!farmRay(bot, support, { height: farmland ? 15 / 16 : 0.999 })) fail('development_unreachable');
  const origin = bot.entity.position, read = worldReader(bot);
  const after = at => sameBlock(at, p) ? { name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : read(at);
  if (![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => farmSegment(after, origin, { x: origin.x + x, y: origin.y, z: origin.z + z }))) fail('development_blocks_exit');
  return support;
}
function sameState(bot, p, original) {
  if (readBlock(bot, p)?.stateId !== original.stateId) fail('development_target_changed');
}
function held(bot, item) {
  if (/_(hoe|shovel)$/.test(item) && (bot.heldItem?.durabilityUsed ?? 0) >= (bot.registry.itemsByName[item]?.maxDurability || 0) - 1) return false;
  return bot.heldItem?.name === item && bot.heldItem.type === bot.registry.itemsByName[item]?.id && bot.heldItem.count > 0; }
export function useBucket(bot, point, session) {
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0);
  const dx = point.x - eye.x, dy = point.y - eye.y, dz = point.z - eye.z;
  const yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
  session.guard(() => bot._client.write('use_item', { hand: 0, sequence: 0, rotation: { x: (Math.PI - yaw) * 180 / Math.PI, y: -pitch * 180 / Math.PI } }));
}
async function interaction(bot, p, policy, session, { item, check, expected, post = () => {}, delta = 0, gained = null, dig = false, bucket = false, ms = 1500 }) {
  session = bindBodySession(bot, session, () => new FarmingError('development_body_changed'));
  const originalTarget = readBlock(bot, p), initial = check();
  const id = bot.registry?.itemsByName?.[item]?.id;
  if (!Number.isInteger(id)) fail('development_item_unknown');
  const recheck = () => { session.guard(() => {}); sameState(bot, p, originalTarget); return check(); };
  let before = await playerSnapshot(bot, session, id, ms); recheck();
  if (before.count < 1) fail('development_item_missing');
  before = await stageCarriedItem(bot, item, id, session, before, ms, recheck);
  let aim = recheck();
  if (!held(bot, item) || before.slots[36 + bot.quickBarSlot]?.type !== id) fail('development_hand_changed');
  const height = item === 'bucket' ? 0.85 : aim.name === 'farmland' ? 15 / 16 : 0.999;
  await boundedFarm(session.guard(() => bot.lookAt(aim.position.offset(0.5, height, 0.5), true)), session.signal, ms, 'development_aim_timeout');
  aim = recheck(); if (!held(bot, item)) fail('development_hand_changed');
  let observed = false, sent = false, resolve, reject, failure;
  const response = new Promise((yes, no) => { resolve = yes; reject = no; }); response.catch(() => {});
  const invalidate = e => { failure ||= e; reject(e); };
  const watch = () => { session.guard(() => {}); developmentBody(bot, p, policy); if (observed) {
    const current = readBlock(bot, p);
    if (!expected(current?.stateId) && !(item === 'bucket' && waterSource(current))) fail('development_result_changed');
    post();
  } else if (!sent && !held(bot, item)) fail('development_hand_changed'); };
  const onBlock = packet => {
    if (!sent || observed || !sameBlock(packet.location, p)) return;
    try { if (!expected(packet.type)) fail('development_wrong_server_block'); observed = true; watch(); resolve(); } catch (error) { invalidate(error); }
  };
  const monitor = setInterval(() => { try { watch(); } catch (error) { invalidate(error); } }, 50);
  const cleanup = () => { clearInterval(monitor); bot._client.removeListener('block_change', onBlock); };
  session.addCleanup(cleanup); bot._client.on('block_change', onBlock);
  try {
    aim = recheck(); if (!held(bot, item)) fail('development_hand_changed');
    sent = true;
    if (dig) {
      const duration = bot.digTime(originalTarget);
      if (!Number.isFinite(duration) || duration < 0 || duration > 2000 || !bot.canDigBlock(originalTarget)) fail('basin_dig_unavailable');
      await boundedFarm(session.guard(() => bot.dig(originalTarget, 'ignore')), session.signal, 2000 + ms, 'basin_dig_timeout');
    } else if (bucket) useBucket(bot, aim.position.offset(0.5, height, 0.5), session);
    else session.guard(() => bot._client.write('block_place', { hand: 0, location: aim.position, direction: 1, cursorX: 0.5, cursorY: height, cursorZ: 0.5, insideBlock: false, sequence: 0 }));
    await boundedFarm(response, session.signal, ms, 'development_server_confirmation_missing');
    if (failure) throw failure;
    const after = await playerSnapshot(bot, session, id, ms); watch(); if (failure) throw failure;
    if (before.count - after.count !== delta) fail('development_inventory_unconfirmed');
    if (gained) {
      const gainId = bot.registry.itemsByName[gained]?.id, count = snap => snap.slots.slice(9, 45).reduce((n, s) => n + (s?.type === gainId ? s.count : 0), 0);
      if (count(after) - count(before) !== 1) fail('development_bucket_unconfirmed');
    }
    return { position: { x: p.x, y: p.y, z: p.z }, serverBlockVerified: true, serverInventoryVerified: true, exclusiveCausalityClaimed: false };
  } finally { cleanup(); if (dig) { try { session.guard(() => bot.stopDigging()); } catch {} } }
}
export async function tillSoil(bot, p, policy, session, options = {}) {
  const original = checkTilling(bot, p, policy), name = original.name === 'coarse_dirt' ? 'dirt' : 'farmland';
  const hoe = bot.inventory.slots.slice(9, 45).find(i => i && /^(wooden|stone|iron|golden|diamond|netherite)_hoe$/.test(i.name) && (i.durabilityUsed ?? 0) < (bot.registry.itemsByName[i.name]?.maxDurability || 0) - 1);
  if (!hoe) fail('usable_hoe_required');
  return interaction(bot, p, policy, session, { ...options, item: hoe.name, check: () => checkTilling(bot, p, policy), expected: state => bot.registry.blocksByStateId[state]?.name === name });
}
export function digIrrigation(bot, p, policy, session, options = {}) {
  // A carried shovel only; no arbitrary digging, crops or support removal.
  const shovel = bot.inventory.slots.slice(9, 45).find(i => i && /^(wooden|stone|iron|golden|diamond|netherite)_shovel$/.test(i.name) && (i.durabilityUsed ?? 0) < (bot.registry.itemsByName[i.name]?.maxDurability || 0) - 1);
  if (!shovel) fail('usable_shovel_required');
  return interaction(bot, p, policy, session, { ...options, item: shovel.name, dig: true, check: () => checkBasin(bot, p, policy), post: () => checkBasin(bot, p, policy, { dug: true, verifyRay: false }), expected: state => isAir(bot.registry.blocksByStateId[state]) });
}
export function fillWaterBucket(bot, p, policy, session, options = {}) {
  return interaction(bot, p, policy, session, { ...options, item: 'bucket', bucket: true, delta: 1, gained: 'water_bucket', check: () => checkWaterSource(bot, p, policy), post: () => checkWaterSource(bot, p, policy, true), expected: state => isAir(bot.registry.blocksByStateId[state]) });
}
export function irrigateBasin(bot, p, policy, session, options = {}) {
  return interaction(bot, p, policy, session, { ...options, item: 'water_bucket', bucket: true, delta: 1, gained: 'bucket', check: () => checkBasin(bot, p, policy, { dug: true }), post: () => checkBasin(bot, p, policy, { filled: true }), expected: state => state === bot.registry.blocksByName.water.minStateId });
}
export function placeFarmBlock(bot, args, policy, session, options = {}) {
  return interaction(bot, args, policy, session, { ...options, item: args.block, delta: 1, check: () => checkFarmPlacement(bot, args, policy, args.block), expected: state => bot.registry.blocksByStateId[state]?.name === args.block });
}

export function fertilizeCrop(bot, p, policy, session, options = {}) {
  const initial = readBlock(bot, p), crops = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 };
  const age = initial?.getProperties?.().age;
  if (!Object.hasOwn(crops, initial?.name || '') || !/^[0-7]$/.test(String(age)) || Number(age) >= crops[initial.name]) fail('fertilizer_crop_unavailable');
  const check = () => {
    developmentBody(bot, p, policy); const block = readBlock(bot, p);
    if (block?.stateId !== initial.stateId || !farmRay(bot, block, { height: 0.5 })) fail('fertilizer_crop_changed');
    return block;
  };
  const definition = bot.registry.blocksByName[initial.name];
  return interaction(bot, p, policy, session, { ...options, item: 'bone_meal', delta: 1, check, expected: state => bot.registry.blocksByStateId[state]?.name === initial.name && state > initial.stateId && state <= definition.maxStateId });
}
