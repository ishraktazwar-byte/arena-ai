import { chooseProduction, reservedCell } from './production.js';
import { GrowthMonitor } from './growth.js';
import { FARM_CROPS, validFarm } from './intent.js';
import { attachSeedReserve } from './reservations.js';
import { farmFootprint, farmSurface } from './terrain.js';
import { worldReader } from '../escape.js';
import { assessRisk, survivalSnapshot } from '../survival.js';
import { permitsBlock } from '../permissions.js';
import { checkHarvest, cropAge, FarmingError } from '../../shared/tools/farm.js';
import { checkPlanting } from '../../shared/tools/plant.js';
import { scanItems, collectionRouteKnown } from '../../shared/tools/collect.js';
import { planLocalRoute } from '../../shared/tools/navigate.js';
import { readBlock, isAir } from '../../shared/tools/resources.js';
const goal = (tool, args) => ({ tool, args, reason: 'Maintain the chosen farm from fresh observations.' });
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const key = g => JSON.stringify([g.tool, g.args]);
function inventory(bot) {
  const slots = bot.inventory?.slots;
  if (!Array.isArray(slots) || slots.length < 45 || bot.currentWindow || bot.inventory.selectedItem || slots.slice(0, 5).some(Boolean)) return null;
  const counts = {};
  for (const item of slots.slice(9, 45)) {
    if (!item) continue;
    if (!Number.isInteger(item.count) || item.count < 1 || item.count > 64 || bot.registry?.itemsByName?.[item.name]?.id !== item.type) return null;
    counts[item.name] = (counts[item.name] || 0) + item.count;
  }
  return { counts, capacity: slots.slice(9, 45).some(item => !item) };
}
export function farmCells(bot, intent, policy) {
  const cells = [];
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    const p = { x: intent.x + dx, y: intent.y, z: intent.z + dz };
    if (reservedCell(intent, p)) continue;
    if (!permitsBlock(policy, bot.game?.dimension, p) || readBlock(bot, { ...p, y: p.y - 1 })?.name !== 'farmland') continue;
    const block = readBlock(bot, p);
    if (!block) continue;
    cells.push({ ...p, empty: isAir(block), ripe: block.name === intent.crop && cropAge(block) === FARM_CROPS[intent.crop].age, crop: block.name });
  }
  return cells.sort((a, b) => distance(a, bot.entity.position) - distance(b, bot.entity.position));
}
// One freshly grounded action per tick. No persisted phase, packet, entity ID or
// unexecuted plan tail is resumed: partial effects are reconciled from the world.
export function chooseFarmAction(bot, intent, policies, available = () => true, development = {}) {
  const p = bot.entity?.position;
  if (!validFarm(intent) || !intent) return { status: 'inactive' };
  if (!p || bot.version !== '1.21.1' || bot._client?.state !== 'play' || !bot.entity.onGround || bot.health < 12 || (!intent.develop && bot.food < 12) || assessRisk(survivalSnapshot(bot)).mode !== 'NORMAL' || !farmFootprint(worldReader(bot), p)) return { status: 'unsafe' };
  if (![policies.farming, policies.collection, policies.navigation].every(policy => policy?.enabled) || !permitsBlock(policies.farming, bot.game?.dimension, intent)) return { status: 'permission_disabled' };
  if (Math.round(p.y) !== intent.y || distance(p, { x: intent.x + 0.5, z: intent.z + 0.5 }) > 8) return { status: 'away' };
  const inv = inventory(bot);
  if (!inv) return { status: 'inventory_unknown' };
  const spec = FARM_CROPS[intent.crop], seeds = inv.counts[spec.seed] || 0, stock = (inv.counts[spec.produce] || 0) + (intent.develop ? intent.crop === 'potatoes' ? inv.counts.baked_potato || 0 : intent.crop === 'wheat' ? 3 * (inv.counts.bread || 0) : 0 : 0);
  const cells = farmCells(bot, intent, policies.farming), empty = cells.filter(cell => cell.empty);
  const approach = cell => {
    const anchor = { farm: true, entity: bot.entity, dimension: bot.game.dimension, position: { x: p.x, y: p.y, z: p.z } };
    for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const destination = farmSurface(worldReader(bot), cell.x + dx + 0.5, cell.z + dz + 0.5, intent.y);
      if (!destination || distance(p, destination) < 0.25) continue;
      const next = goal('navigate_farm', { x: cell.x + dx, z: cell.z + dz });
      if (!available(next)) continue;
      try { if (planLocalRoute(bot, destination, policies.navigation, anchor).length) return next; } catch { /* Try another freshly observed approach. */ }
    }
    return null;
  };
  // Recover both produce and seed stacks before despawn; each selection still
  // binds a stable identity and independently verifies inventory gain.
  let yieldPending = false;
  if (inv.capacity) for (const item of [...new Set([spec.seed, spec.produce])]) {
    const drops = scanItems(bot, policies.collection, { expectedItem: item, eligibleOnly: true }).items;
    for (const drop of drops) {
      if (Math.abs(drop.position.x - (intent.x + 0.5)) > 3 || Math.abs(drop.position.z - (intent.z + 0.5)) > 3) continue;
      yieldPending = true;
      if (!collectionRouteKnown(bot, drop.position, policies.collection)) {
        const route = approach({ x: Math.floor(drop.position.x), y: intent.y, z: Math.floor(drop.position.z) });
        if (route) return { status: 'approaching_yield', goal: route };
        continue;
      }
      const next = goal('collect_items', { entityId: drop.entityId, entityUuid: drop.entityUuid, expectedItem: item });
      if (available(next)) return { status: 'recovering_yield', goal: next };
    }
  }
  if (yieldPending) return { status: 'yield_blocked' };
  const production = chooseProduction(bot, intent, policies, approach, available, development);
  if (production) return production;
  if (!cells.length) return { status: 'no_known_farmland' };
  const work = (cell, plant) => {
    if (!plant && distance(p, { x: cell.x + 0.5, z: cell.z + 0.5 }) > 1.25) return approach(cell);
    const args = { x: cell.x, y: cell.y, z: cell.z, [plant ? 'crop' : 'expectedCrop']: intent.crop };
    const next = goal(plant ? 'plant_crop' : 'harvest_crop', args);
    if (!available(next)) return null;
    try { (plant ? checkPlanting : checkHarvest)(bot, args, policies.farming); return next; }
    catch (error) {
      if (['harvest_unreachable', 'harvest_body_column', 'plant_soil_unreachable'].includes(error.code)) return approach(cell);
      return null;
    }
  };
  if (empty.length) {
    if (!seeds) {
      if (intent.develop && !development.bootstrapPending) for (const cell of cells.filter(cell => cell.ripe)) { const next = work(cell, false); if (next) return { status: 'multiplying_planting_stock', goal: next }; }
      return { status: development.bootstrapPending ? 'bootstrap_yield_missing' : 'seed_shortage' };
    }
    for (const cell of empty) { const next = work(cell, true); if (next) return { status: 'replanting', goal: next }; }
    return { status: 'replant_blocked' };
  }
  const target = intent.targetStock + (spec.seed === spec.produce ? intent.reserve : 0);
  if (stock >= target && seeds >= intent.reserve) return { status: 'stock_satisfied' };
  if (!inv.capacity) return { status: 'inventory_full' };
  for (const cell of cells.filter(cell => cell.ripe)) { const next = work(cell, false); if (next) return { status: 'harvesting', goal: next }; }
  return { status: cells.some(cell => cell.ripe) ? 'harvest_blocked' : development.growth?.some(cell => cell.suspectedStall) ? 'production_growth_stall_unresolved' : 'waiting_for_growth' };
}
export class FarmManager {
  constructor({ bot, memory, policies, execute, emit = () => {}, now = Date.now }) {
    Object.assign(this, { bot, memory, policies, execute, emit, now });
    this.growthMonitor = new GrowthMonitor({ now }); this.growth = []; this.cookingPending = false; this.smeltingPending = false; this.nextCookingProbe = 0;
    this.busy = false; this.active = false; this.epoch = 0; this.nextAt = 0; this.failures = new Map(); this.lastStatus = '';
    attachSeedReserve(bot, () => {
      const farm = this.intent();
      return farm && this.active && permitsBlock(this.policies.farming, this.bot.game?.dimension, farm) && [this.policies.farming, this.policies.collection, this.policies.navigation].every(p => p.enabled) ? { ...farm, seed: FARM_CROPS[farm.crop].seed, count: farm.reserve + (farm.develop ? farmCells(bot, farm, this.policies.farming).filter(cell => cell.empty).length : 0) } : null;
    });
  }
  intent() { return this.memory?.retrieveFarm({ dimension: this.bot.game?.dimension }) || null; }
  status() { return { intent: this.intent(), state: this.lastStatus || 'inactive', recovery: 'fresh_world_reconciliation', growth: structuredClone(this.growth) }; }
  start() { this.active = true; this.epoch++; this.nextAt = 0; }
  stop() { this.active = false; this.epoch++; }
  async setGoal(farm, session) {
    if (!this.memory || !validFarm(farm)) throw new FarmingError('farm_intent_unavailable');
    const entity = this.bot.entity, dimension = this.bot.game?.dimension;
    const guard = () => session.guard(() => {
      if (this.bot.entity !== entity || this.bot.game?.dimension !== dimension) throw new FarmingError('farm_body_changed');
      if (farm && (!this.policies.farming.enabled || !this.policies.collection.enabled || !this.policies.navigation.enabled || !permitsBlock(this.policies.farming, dimension, farm) || !entity?.position || distance(entity.position, farm) > 6 || Math.round(entity.position.y) !== farm.y || !(farm.develop ? ['farmland', 'dirt', 'grass_block', 'coarse_dirt', 'dirt_path'] : ['farmland']).includes(readBlock(this.bot, { x: farm.x, y: farm.y - 1, z: farm.z })?.name) || farm.develop && !this.policies.workspace?.enabled)) throw new FarmingError('farm_site_unavailable');
    });
    guard();
    await this.memory.remember('farm_intent', { dimension, position: entity?.position ? { x: entity.position.x, y: entity.position.y, z: entity.position.z } : null }, { farm });
    guard(); this.failures.clear(); this.growth = []; this.growthMonitor.records.clear(); this.cookingPending = false; this.smeltingPending = false; this.nextCookingProbe = 0; this.nextAt = 0;
    return { intentionPersisted: true, farm: structuredClone(farm), futureYieldGuaranteed: false };
  }
  tick() {
    if (!this.active || this.busy || this.now() < this.nextAt) return Promise.resolve();
    this.pending = this.runTick();
    return this.pending;
  }
  settle() { return this.pending || Promise.resolve(); }
  async runTick() {
    if (!this.active || this.busy || this.now() < this.nextAt) return;
    this.busy = true; const epoch = this.epoch, intent = this.intent(), scope = JSON.stringify([this.bot.game?.dimension, intent]);
    this.nextAt = this.now() + 2000;
    try {
      for (const [k, value] of this.failures) if (this.now() < value.at || this.now() - value.at > 600000) this.failures.delete(k);
      this.growth = intent ? this.growthMonitor.observe(this.bot, intent, farmCells(this.bot, intent, this.policies.farming)) : [];
      const progress = this.memory?.retrieveFarmProgress?.({ dimension: this.bot.game?.dimension });
      const seedCount = intent ? this.bot.inventory?.slots?.slice(9, 45).reduce((n, item) => n + (item?.name === FARM_CROPS[intent.crop].seed ? item.count : 0), 0) || 0 : 0;
      const bootstrapPending = seedCount === 0 && progress?.bootstrapPending && JSON.stringify(progress.farm) === JSON.stringify(intent);
      const decision = chooseFarmAction(this.bot, intent, this.policies, g => (this.failures.get(scope + key(g))?.until || 0) <= this.now(), { bootstrapPending, growth: this.growth, cookingPending: this.cookingPending, smeltingPending: this.smeltingPending, probeCooking: this.now() >= this.nextCookingProbe });
      if (decision.status !== this.lastStatus) { this.lastStatus = decision.status; this.emit({ type: 'FARM-STATUS', status: decision.status }); }
      if (!decision.goal || !this.active || epoch !== this.epoch) return;
      const observation = { dimension: this.bot.game.dimension, position: { x: this.bot.entity.position.x, y: this.bot.entity.position.y, z: this.bot.entity.position.z } };
      if (decision.goal.tool === 'fertilize_crop') this.growthMonitor.attempted(decision.goal.args);
      if (['cook_food', 'smelt_iron'].includes(decision.goal.tool)) this.nextCookingProbe = this.now() + 30000;
      let result;
      try { result = await this.execute(decision.goal); } catch { result = { state: 'FAILED' }; }
      if (decision.goal.tool === 'cook_food' && result.state === 'COMPLETED') this.cookingPending = ['input_loaded', 'fuel_loaded', 'processing'].includes(result.result?.phase);
      if (decision.goal.tool === 'smelt_iron' && result.state === 'COMPLETED') this.smeltingPending = ['input_loaded', 'fuel_loaded', 'processing'].includes(result.result?.phase);
      if (intent?.develop && decision.goal.tool === 'harvest_crop' && seedCount === 0 && isAir(readBlock(this.bot, decision.goal.args))) await this.memory.remember('farm_progress', observation, { farm: intent, bootstrapPending: true });
      else if (intent?.develop && seedCount > 0 && progress?.bootstrapPending) await this.memory.remember('farm_progress', observation, { farm: intent, bootstrapPending: false });
      const k = scope + key(decision.goal);
      if (result.state === 'COMPLETED') this.failures.delete(k);
      else {
        const count = Math.min(5, (this.failures.get(k)?.count || 0) + 1);
        this.failures.set(k, { count, at: this.now(), until: this.now() + Math.min(60000, 5000 * 2 ** (count - 1)) });
        while (this.failures.size > 64) this.failures.delete(this.failures.keys().next().value);
      }
      // Historical outcome only. A cancellation may already have changed the
      // world; the next tick does not reuse this goal or its entity target.
      await this.memory.remember('goal_result', observation, { tool: decision.goal.tool, state: result.state });
      this.emit({ type: 'FARM-WORK', tool: decision.goal.tool, state: result.state, reason: result.reason || null });
    } catch { this.emit({ type: 'FARM-ERROR', code: 'farm_work_unavailable' }); }
    finally { this.busy = false; this.nextAt = Math.max(this.nextAt, this.now() + 1000); }
  }
}
