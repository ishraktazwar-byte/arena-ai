import { farmFootprint, farmPassable } from '../../src/farming/terrain.js';
import { bindBodySession } from '../../src/control.js';
import { permitsBlock } from '../../src/permissions.js';
import { worldReader } from '../../src/escape.js';
import { assessRisk, survivalSnapshot } from '../../src/survival.js';
import { readBlock, visibleResource as resourceVisible, sameBlock, isAir } from './resources.js';

const visibleResource = (bot, block) => resourceVisible(bot, block, { passable: farmPassable });
export const cropSeeds = Object.freeze({ wheat: 'wheat_seeds', carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds' });
export const cropAges = Object.freeze({ wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 });
export class FarmingError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new FarmingError(code); };
export function cropAge(block) {
  if (!Object.hasOwn(cropAges, block?.name || '')) return null;
  let age; try { age = block.getProperties?.().age; } catch { return null; }
  // Pinned Prismarine block properties encode integer state values as strings.
  if (typeof age === 'string' && /^[0-9]$/.test(age)) age = Number(age);
  return Number.isInteger(age) && age >= 0 && age <= cropAges[block.name] ? age : null;
}
function checkBody(bot) {
  if (bot.version !== '1.21.1' || bot._client?.state !== 'play') fail('harvest_protocol_unavailable');
  // Harvesting does not walk or sprint. Hunger alone must not prevent a safe,
  // motionless food-gathering action; danger and unknown vitals still stop it.
  if (!bot.entity?.onGround || bot.health < 8 || assessRisk(survivalSnapshot(bot)).mode !== 'NORMAL' || !farmFootprint(worldReader(bot), bot.entity.position)) fail('harvest_unsafe_body');
  if (!Array.isArray(bot.inventory?.slots) || bot.inventory.slots.length < 45 || bot.currentWindow || bot.inventory.selectedItem || bot.inventory.slots.slice(0, 5).some(Boolean)) fail('harvest_inventory_busy');
}
function checkSite(bot, args, policy, soilState) {
  checkBody(bot);
  if (!permitsBlock(policy, bot.game?.dimension, args)) fail('outside_farming_permission');
  const p = bot.entity.position;
  if (args.y < Math.round(p.y) || args.y > Math.round(p.y) + 1) fail('harvest_vertical_reach');
  if (args.x + 1 > p.x - 0.32 && args.x < p.x + 0.32 && args.z + 1 > p.z - 0.32 && args.z < p.z + 0.32) fail('harvest_body_column');
  if (!visibleResource(bot, readBlock(bot, args))) fail('harvest_unreachable');
  const soil = readBlock(bot, { x: args.x, y: args.y - 1, z: args.z });
  if (!soil || soil.name !== 'farmland' || !Number.isInteger(soil.stateId) || (soilState !== undefined && soil.stateId !== soilState)) fail('harvest_soil_changed');
  return soil;
}
export function checkHarvest(bot, args, policy, expectedState, soilState) {
  const soil = checkSite(bot, args, policy, soilState);
  if (bot.heldItem && (!bot.inventory.slots.slice(36, 45).some(slot => slot == null) || typeof bot.setQuickBarSlot !== 'function')) fail('harvest_empty_hand_unavailable');
  const block = readBlock(bot, args), age = cropAge(block);
  if (!block || block.name !== args.expectedCrop || age === null || (expectedState !== undefined && block.stateId !== expectedState)) fail('harvest_crop_changed');
  if (age !== cropAges[block.name]) fail('harvest_not_mature');
  if (!Number.isInteger(block.stateId) || !block.diggable || typeof block.canHarvest !== 'function' || !block.canHarvest(null) || !bot.canDigBlock?.(block) || !visibleResource(bot, block)) fail('harvest_unreachable');
  return { block, soil };
}
export function scanCrops(bot, policy = { enabled: false }) {
  const result = { enabled: !!policy.enabled, crops: [], plantingSites: [] }, p = bot.entity?.position;
  if (!p?.offset || !bot.blockAt || !['x', 'y', 'z'].every(key => Number.isFinite(p[key]) && Math.abs(p[key]) <= 30000000)) return result;
  for (let dx = -4; dx <= 4; dx++) for (let dy = -1; dy <= 3; dy++) for (let dz = -4; dz <= 4; dz++) {
    const block = readBlock(bot, { x: Math.floor(p.x) + dx, y: Math.round(p.y) + dy, z: Math.floor(p.z) + dz });
    if (isAir(block) && readBlock(bot, { x: block.position.x, y: block.position.y - 1, z: block.position.z })?.name === 'farmland' && visibleResource(bot, block)) {
      const position = { x: block.position.x, y: block.position.y, z: block.position.z };
      const seedOptions = Object.entries(cropSeeds).filter(([, seed]) => bot.inventory?.slots?.slice(9, 45).some(item => item?.name === seed && item.count > 0)).map(([crop]) => crop);
      result.plantingSites.push({ position, authorized: permitsBlock(policy, bot.game?.dimension, position), seedOptions, executionRecheckRequired: true, distance: p.distanceTo(block.position.offset(0.5, 0.5, 0.5)) });
    }
    const age = cropAge(block);
    if (age === null || !visibleResource(bot, block)) continue;
    const position = { x: block.position.x, y: block.position.y, z: block.position.z };
    let eligible = false, reason = 'farming_disabled';
    if (policy.enabled) {
      try { checkHarvest(bot, { ...position, expectedCrop: block.name }, policy); eligible = true; reason = 'local_checks_passed'; }
      catch (error) { reason = error instanceof FarmingError ? error.code : 'harvest_unavailable'; }
    }
    result.crops.push({ crop: block.name, position, age, mature: age === cropAges[block.name], eligible, reason, distance: p.distanceTo(block.position.offset(0.5, 0.5, 0.5)) });
  }
  result.crops.sort((a, b) => a.distance - b.distance);
  result.crops = result.crops.slice(0, 16);
  result.plantingSites.sort((a, b) => a.distance - b.distance);
  result.plantingSites = result.plantingSites.slice(0, 8);
  return result;
}
function bounded(promise, signal, ms, code) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const abort = () => finish(new FarmingError('harvest_interrupted'));
    const timer = setTimeout(() => finish(new FarmingError(code)), ms);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    Promise.resolve(promise).then(value => finish(null, value), error => finish(error));
  });
}
export async function harvestCrop(bot, args, policy, session, { confirmationMs = 1500, aimMs = 1500 } = {}) {
  session = bindBodySession(bot, session, () => new FarmingError('harvest_body_changed'));
  const initial = checkHarvest(bot, args, policy);
  const state = initial.block.stateId, soilState = initial.soil.stateId;
  if (bot.heldItem) {
    const empty = bot.inventory.slots.slice(36, 45).findIndex(slot => slot == null);
    if (empty < 0 || typeof bot.setQuickBarSlot !== 'function') fail('harvest_empty_hand_unavailable');
    session.guard(() => bot.setQuickBarSlot(empty));
  }
  if (bot.heldItem) fail('harvest_hand_changed');
  await bounded(session.guard(() => bot.lookAt(initial.block.position.offset(0.5, 0.5, 0.5), true)), session.signal, aimMs, 'harvest_aim_timeout');
  session.guard(() => {});
  const { block } = checkHarvest(bot, args, policy, state, soilState);
  if (bot.heldItem) fail('harvest_hand_changed');
  const digMs = bot.digTime(block);
  if (!Number.isFinite(digMs) || digMs < 0 || digMs > 2000) fail('harvest_dig_too_slow');
  if (typeof session.addCleanup !== 'function' || !bot._client?.on || !bot._client?.removeListener) fail('harvest_confirmation_unavailable');
  let sent = false, confirmed = false, resolveConfirmation, rejectFailure, monitor;
  const confirmation = new Promise(resolve => { resolveConfirmation = resolve; });
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  const onBlock = packet => {
    if (!sent || !sameBlock(packet.location, args)) return;
    try {
      session.guard(() => {}); checkSite(bot, args, policy, soilState);
      if (isAir(bot.registry?.blocksByStateId?.[packet.type])) { confirmed = true; resolveConfirmation(); }
      else if (packet.type !== state) fail('harvest_crop_changed');
    } catch (error) { rejectFailure(error); }
  };
  const cleanup = () => { clearInterval(monitor); bot._client.removeListener('block_change', onBlock); };
  session.addCleanup(cleanup); bot._client.on('block_change', onBlock);
  monitor = setInterval(() => {
    try {
      session.guard(() => {}); checkSite(bot, args, policy, soilState);
      if (bot.heldItem) fail('harvest_hand_changed');
      const current = readBlock(bot, args);
      if (!isAir(current)) checkHarvest(bot, args, policy, state, soilState);
    } catch (error) { rejectFailure(error); }
  }, 50);
  try {
    await bounded(Promise.race([(async () => {
      await session.guard(() => { sent = true; return bot.dig(block, 'ignore'); });
      session.guard(() => {});
      // The server reply is required even if Mineflayer predicts local air.
      await confirmation;
    })(), failure]), session.signal, Math.ceil(digMs) + confirmationMs, 'harvest_server_confirmation_missing');
    session.guard(() => {}); checkSite(bot, args, policy, soilState);
    if (!confirmed || bot.heldItem) fail('harvest_unconfirmed');
    return { crop: args.expectedCrop, position: { x: args.x, y: args.y, z: args.z }, serverObservedAir: true, dropsCollected: 'not_verified', replanted: false, exclusiveCausalityClaimed: false };
  } finally {
    cleanup();
    try { session.guard(() => bot.stopDigging()); } catch { /* New owner controls cleanup after interruption. */ }
  }
}

export { checkBody as checkFarmBody, checkSite as checkFarmSite, bounded as boundedFarm };
