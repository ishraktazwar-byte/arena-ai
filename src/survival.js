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
      id: entity.id, name: entity.name, distance: entity.position.distanceTo(position)
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
    this.generation = 0;
    this.nextEatAt = 0;
    this.releaseAt = 0;
    this.floor = 0;
    this.lastDiagnostic = '';
  }
  start() { this.active = true; this.generation++; this.nextEatAt = 0; this.releaseAt = 0; this.floor = 0; this.lastDiagnostic = ''; }
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
      this.emit({ type: 'SURVIVAL-DIAG', ...risk, enforcedFloor: this.floor, foodAvailable: !!item, response: this.floor >= 1000 ? 'halt_only_escape_not_implemented' : 'reassess' });
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
