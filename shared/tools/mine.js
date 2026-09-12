import { setTimeout as delay } from 'node:timers/promises';
import { safeFootprint, worldReader } from '../../src/escape.js';
import { assessRisk, survivalSnapshot } from '../../src/survival.js';
import { readBlock, visibleResource, resourceNames, sameBlock, isLog, isAir } from './resources.js';

export class MiningError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const reject = code => { throw new MiningError(code); };
const hazard = block => !block || ['water', 'lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'powder_snow', 'sand', 'red_sand', 'gravel', 'anvil', 'chipped_anvil', 'damaged_anvil', 'pointed_dripstone'].includes(block.name) || block.name.endsWith('_concrete_powder') || block.getProperties?.().waterlogged === true || block.getProperties?.().waterlogged === 'true';
export function miningAllowed(policy, dimension, p) {
  const a = policy?.area;
  return policy?.enabled === true && a && dimension === policy.dimension && p.x >= a.minX && p.x <= a.maxX && p.y >= a.minY && p.y <= a.maxY && p.z >= a.minZ && p.z <= a.maxZ;
}
function checkBody(bot) {
  if (!bot.entity?.onGround || bot.health < 12 || bot.food < 12 || assessRisk(survivalSnapshot(bot)).mode !== 'NORMAL') reject('unsafe_body');
  if (!safeFootprint(worldReader(bot), bot.entity.position)) reject('unsafe_footing');
}
export function checkMining(bot, args, policy, expectedState) {
  if (!miningAllowed(policy, bot.game?.dimension, args)) reject('outside_mining_permission');
  checkBody(bot);
  const p = bot.entity.position;
  if (args.y < Math.floor(p.y) || args.y > Math.floor(p.y) + 1) reject('vertical_dig_forbidden');
  // Never remove the body/footprint or its supporting block.
  if (args.x + 1 > p.x - 0.32 && args.x < p.x + 0.32 && args.z + 1 > p.z - 0.32 && args.z < p.z + 0.32) reject('body_column_forbidden');
  const block = readBlock(bot, args);
  if (!block || block.name !== args.expectedBlock || (expectedState !== undefined && block.stateId !== expectedState)) reject('stale_block');
  if (!resourceNames.has(block.name) || !block.diggable || !bot.canDigBlock(block)) reject('unsupported_block');
  if (hazard(block) || !visibleResource(bot, block)) reject('blocked_or_hazardous_target');
  for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    if (hazard(readBlock(bot, { x: args.x + x, y: args.y + y, z: args.z + z }))) reject('unsafe_neighbor');
  }
  return block;
}
export function chooseMiningTool(bot, block) {
  if (typeof block.canHarvest !== 'function') reject('unknown_harvest_requirements');
  const suffix = isLog(block.name) ? '_axe' : '_pickaxe';
  const tier = { wooden: 1, golden: 2, stone: 3, iron: 4, diamond: 5, netherite: 6 };
  const candidates = (bot.inventory?.items() || []).filter(item => {
    const max = bot.registry?.itemsByName?.[item.name]?.maxDurability;
    return item.count > 0 && item.name.endsWith(suffix) && block.canHarvest(item.type) && (!max || (item.durabilityUsed ?? 0) < max - 1);
  }).sort((a, b) => (tier[b.name.split('_')[0]] || 0) - (tier[a.name.split('_')[0]] || 0));
  if (candidates.length) return candidates[0];
  if (isLog(block.name) && block.canHarvest(null)) return null;
  reject('missing_harvest_tool');
}
function inventoryCounts(bot) {
  const counts = new Map();
  for (const item of bot.inventory?.items() || []) counts.set(item.name, (counts.get(item.name) || 0) + item.count);
  return counts;
}

export async function mineBlock(bot, args, policy, session, { confirmationMs = 1500 } = {}) {
  const { guard, signal } = session;
  let block = checkMining(bot, args, policy);
  const expectedState = block.stateId;
  const tool = chooseMiningTool(bot, block);
  if (tool && bot.heldItem?.type !== tool.type) await guard(() => bot.equip(tool, 'hand'));
  else if (!tool && bot.heldItem) await guard(() => bot.unequip('hand'));
  guard(() => {});
  block = checkMining(bot, args, policy, expectedState);
  await guard(() => bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true));
  guard(() => {});
  block = checkMining(bot, args, policy, expectedState);
  if ((bot.heldItem?.type ?? null) !== (tool?.type ?? null) || !block.canHarvest(bot.heldItem?.type ?? null)) reject('equipment_changed');
  const digMs = bot.digTime(block);
  if (!Number.isFinite(digMs) || digMs < 0 || digMs > 8000) reject('dig_duration_exceeded');
  if (!bot._client?.on || !bot._client?.removeListener) reject('confirmation_unavailable');
  const localAbort = new AbortController();
  const waitSignal = AbortSignal.any([signal, localAbort.signal]);
  let confirmed = false, resolveConfirmation;
  const confirmation = new Promise(resolve => { resolveConfirmation = resolve; });
  const onChange = packet => {
    if (sameBlock(packet.location, args) && isAir(bot.registry?.blocksByStateId?.[packet.type])) { confirmed = true; resolveConfirmation(); }
  };
  const before = inventoryCounts(bot);
  let monitor;
  const failure = new Promise((_, rejectPromise) => {
    monitor = setInterval(() => {
      try {
        guard(() => {});
        checkBody(bot);
        if (!miningAllowed(policy, bot.game?.dimension, args)) reject('outside_mining_permission');
        if ((bot.heldItem?.type ?? null) !== (tool?.type ?? null)) reject('equipment_changed');
        const current = readBlock(bot, args);
        // Mineflayer locally predicts air at dig completion. Only a server packet
        // counts as confirmation; do not mistake the optimistic cache for proof.
        if (!isAir(current)) checkMining(bot, args, policy, expectedState);
      } catch (error) { rejectPromise(error); }
    }, 50);
  });
  bot._client.on('block_change', onChange);
  try {
    await Promise.race([
      (async () => {
        // 'ignore' avoids an unguarded internal async look before dig starts.
        await guard(() => bot.dig(block, 'ignore'));
        guard(() => {});
        if (!confirmed) await Promise.race([confirmation, delay(confirmationMs, undefined, { signal: waitSignal }).then(() => reject('server_confirmation_missing'))]);
        guard(() => {});
      })(), failure
    ]);
    const after = inventoryCounts(bot);
    const gains = [...after].filter(([name, count]) => count > (before.get(name) || 0)).map(([name, count]) => ({ name, count: count - (before.get(name) || 0) }));
    return { block: args.expectedBlock, position: { x: args.x, y: args.y, z: args.z }, serverObservedAir: true, inventoryGainsObserved: gains, dropsCollected: 'not_guaranteed' };
  } finally {
    localAbort.abort();
    clearInterval(monitor);
    bot._client.removeListener('block_change', onChange);
    try { guard(() => bot.stopDigging()); } catch { /* New owner already controls cleanup. */ }
  }
}
