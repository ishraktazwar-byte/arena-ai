import { planEscape, executeEscape, worldReader } from './escape.js';
// Conservative policy, not a complete Minecraft danger model.
const HOSTILES = new Set(['zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'spider', 'cave_spider', 'pillager', 'vindicator', 'ravager', 'witch', 'creeper', 'silverfish', 'endermite', 'phantom', 'blaze', 'wither_skeleton', 'hoglin', 'zoglin']);
const HAZARDS = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'sweet_berry_bush', 'powder_snow', 'wither_rose']);
// Intentionally excludes raw meat, rotten flesh, pufferfish, suspicious stew,
// chorus fruit and valuable golden foods. Broaden only with explicit policy.
const FOODS = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_salmon', 'cooked_chicken', 'baked_potato', 'bread', 'cooked_cod', 'cooked_rabbit', 'carrot', 'apple', 'beetroot', 'melon_slice'];

export function survivalSnapshot(bot) {
  const position = bot.entity?.position;
  const blocks = position && bot.blockAt ? [0, -1].map(y => bot.blockAt(position.offset(0, y, 0))) : [];
  return {
    health: bot.health, food: bot.food, oxygen: bot.oxygenLevel,
    hazardousBlock: blocks.find(block => HAZARDS.has(block?.name))?.name ?? null,
    entities: position ? Object.values(bot.entities || {}).filter(entity => entity !== bot.entity && entity.position).map(entity => ({
      id: entity.id, name: entity.name, position: { x: entity.position.x, y: entity.position.y, z: entity.position.z }, distance: entity.position.distanceTo(position)
    })) : [],
    items: bot.inventory?.items() ?? []
  };
}

export function assessRisk(snapshot) {
  if (!Number.isFinite(snapshot.health) || !Number.isFinite(snapshot.food)) return { mode: 'HALT', reason: 'unknown_vitals', floor: 1000 };
  if (snapshot.health <= 0) return { mode: 'HALT', reason: 'dead', floor: 1000 };
  if (snapshot.hazardousBlock) return { mode: 'HALT', reason: 'hazardous_block', floor: 1000 };
  if (Number.isFinite(snapshot.oxygen) && snapshot.oxygen <= 60) return { mode: 'HALT', reason: 'low_oxygen', floor: 1000 };
  const nearby = (snapshot.entities || []).filter(e => Number.isFinite(e.distance) && e.distance >= 0);
  if (nearby.some(e => e.name === 'creeper' && e.distance <= 4)) return { mode: 'HALT', reason: 'close_creeper', floor: 1000 };
  if (snapshot.health <= 6) return { mode: 'RECOVER', reason: 'critical_health', floor: 500 };
  if (nearby.some(e => HOSTILES.has(e.name) && e.distance <= 6)) return { mode: 'ALERT', reason: 'nearby_hostile', floor: 0 };
  return { mode: 'NORMAL', reason: 'no_detected_urgent_risk', floor: 0 };
}

export function selectFood(items) {
  for (const name of FOODS) {
    const item = items.find(item => item.name === name && item.count > 0);
    if (item) return item;
  }
  return null;
}

export class SurvivalController {
  constructor(bot, arbiter, emit, { now = Date.now, recoveryMs = 1500, retryMs = 5000 } = {}) {
    Object.assign(this, { bot, arbiter, emit, now, recoveryMs, retryMs });
    this.active = false;
    this.busy = false;
    this.escaping = false;
    this.nextEscapeAt = 0;
    this.lastEscapeDiagnostic = null;
    this.generation = 0;
    this.nextEatAt = 0;
    this.releaseAt = 0;
    this.floor = 0;
    this.lastDiagnostic = '';
  }
  start() { this.active = true; this.generation++; this.nextEatAt = 0; this.nextEscapeAt = 0; this.lastEscapeDiagnostic = null; this.releaseAt = 0; this.floor = 0; this.lastDiagnostic = ''; }
  stop() {
    this.active = false;
    this.generation++;
    this.arbiter.setSafetyFloor(1000, 'body_unavailable');
    this.arbiter.cancel('survival_stopped');
  }
  tick() {
    if (!this.active) return;
    const snapshot = survivalSnapshot(this.bot);
    const risk = assessRisk(snapshot);
    const now = this.now();
    if (risk.floor >= this.floor) {
      this.floor = risk.floor;
      this.releaseAt = now + this.recoveryMs;
    } else if (now >= this.releaseAt) this.floor = risk.floor;
    this.arbiter.setSafetyFloor(this.floor, risk.reason);
    const unsafeToEat = (snapshot.entities || []).some(e => HOSTILES.has(e.name) && e.distance <= 6);
    if ((risk.mode === 'ALERT' || unsafeToEat) && this.arbiter.current?.owner === 'survival-eat') this.arbiter.cancel('unsafe_to_eat');
    const item = selectFood(snapshot.items);
    const hungry = snapshot.food <= 14 || (snapshot.health < 20 && snapshot.food < 20);
    const diagnostic = `${risk.mode}:${risk.reason}:${this.floor}:${hungry && !item ? 'no_food' : 'food_ok'}`;
    if (diagnostic !== this.lastDiagnostic) {
      this.lastDiagnostic = diagnostic;
      this.emit({ type: 'SURVIVAL-DIAG', ...risk, enforcedFloor: this.floor, foodAvailable: !!item, response: this.floor >= 1000 ? 'ground_escape_if_supported_otherwise_halt' : 'reassess' });
    }
    const needsEscape = risk.reason === 'close_creeper' || (risk.reason === 'critical_health' && unsafeToEat);
    if (this.arbiter.current?.owner === 'survival-escape' && (!needsEscape || ['hazardous_block', 'low_oxygen', 'dead', 'unknown_vitals'].includes(risk.reason))) this.arbiter.cancel('escape_no_longer_applicable');
    if (needsEscape && !this.escaping && now >= this.nextEscapeAt) {
      const threats = snapshot.entities.filter(e => HOSTILES.has(e.name) && e.distance <= 12);
      const plan = planEscape({ position: this.bot.entity?.position, onGround: this.bot.entity?.onGround, blockAt: worldReader(this.bot), threats });
      if (plan.state === 'PLANNED') {
        const generation = this.generation;
        this.escaping = true;
        this.nextEscapeAt = now + 800;
        void this.arbiter.run('survival-escape', 1000, session => executeEscape(this.bot, plan.destination, session, {
          stillNeeded: () => {
            if (!this.active || generation !== this.generation) return false;
            const current = survivalSnapshot(this.bot);
            const currentRisk = assessRisk(current);
            if (!['close_creeper', 'critical_health'].includes(currentRisk.reason)) return false;
            const position = this.bot.entity?.position;
            const nearby = current.entities.filter(e => HOSTILES.has(e.name) && e.distance <= 12);
            if (!position || !nearby.length) return false;
            const separation = p => Math.min(...nearby.map(e => Math.hypot(p.x - e.position.x, p.z - e.position.z)));
            return separation(plan.destination) >= separation(position);
          }
        }), 1000).then(result => {
          if (this.active && generation === this.generation) this.emit({ type: 'ESCAPE-RESULT', destination: plan.destination, ...result });
        }).finally(() => { this.escaping = false; });
      } else {
        this.nextEscapeAt = now + 1000;
        if (plan.reason !== this.lastEscapeDiagnostic) this.emit({ type: 'ESCAPE-BLOCKED', reason: plan.reason });
      }
      this.lastEscapeDiagnostic = plan.reason || null;
    }
    if (this.busy || this.floor > 700 || unsafeToEat || !hungry || !item || now < this.nextEatAt) return;
    const generation = this.generation;
    this.busy = true;
    this.nextEatAt = now + this.retryMs;
    void this.arbiter.run('survival-eat', 700, async ({ guard }) => {
      // Re-check ownership after every asynchronous library operation.
      await guard(() => this.bot.equip(item, 'hand'));
      await guard(() => this.bot.consume());
    }, 8000).then(result => {
      if (this.active && generation === this.generation) this.emit({ type: 'SURVIVAL-EAT', item: item.name, ...result });
    }).finally(() => { this.busy = false; });
  }
}
