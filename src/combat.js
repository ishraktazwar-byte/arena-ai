import { executeEscape, safeSegment, worldReader } from './escape.js';

const ORDINARY = new Set(['zombie', 'husk', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'spider', 'cave_spider', 'pillager']);
const MATERIAL = { wooden: 4, golden: 4, stone: 5, iron: 6, diamond: 7, netherite: 8 };

export function bestMelee(items) {
  return items.map(item => {
    const [material, kind] = item.name.split('_');
    if (!MATERIAL[material] || !['sword', 'axe', 'pickaxe', 'shovel'].includes(kind) || item.count <= 0) return null;
    const damage = MATERIAL[material] + ({ sword: 0, axe: 2, pickaxe: -2, shovel: -1.5 }[kind]);
    const cooldownMs = kind === 'sword' ? 700 : kind === 'axe' ? 1250 : 1100;
    return { item, damage, cooldownMs, score: damage / cooldownMs };
  }).filter(Boolean).sort((a, b) => b.score - a.score)[0] ?? null;
}

export function selectCombat({ health, food, entities, weapon, currentTargetId }) {
  if (!Number.isFinite(health) || !Number.isFinite(food) || health <= 0) return { mode: 'IDLE', reason: 'unavailable_vitals' };
  if (entities.some(e => e.name === 'creeper' && e.distance <= 4)) return { mode: 'EMERGENCY', reason: 'close_creeper' };
  if (health <= 6) return { mode: 'FLEE', reason: 'critical_health' };
  if (health < 12 || food < 10 || !weapon || weapon.damage < 4) return { mode: 'IDLE', reason: 'insufficient_combat_capability' };
  const candidates = entities.filter(e => ORDINARY.has(e.name) && e.distance <= 6 && e.verticalDifference <= 2 && e.valid !== false);
  const retained = candidates.find(e => e.id === currentTargetId);
  const target = retained || candidates.sort((a, b) => a.distance - b.distance || a.id - b.id)[0];
  if (!target) return { mode: 'IDLE', reason: 'no_relevant_target' };
  return { mode: 'MELEE', targetId: target.id, reason: retained ? 'retain_target' : 'nearest_manageable_target' };
}

export function combatSnapshot(bot) {
  const position = bot.entity?.position;
  return {
    health: bot.health, food: bot.food,
    entities: position ? Object.values(bot.entities || {}).filter(e => e !== bot.entity && e.position).map(e => ({ id: e.id, name: e.name, valid: e.isValid, distance: e.position.distanceTo(position), verticalDifference: Math.abs(e.position.y - position.y) })) : [],
    weapon: bestMelee(bot.inventory?.items() || [])
  };
}

export function clearMeleeLine(bot, target) {
  const origin = bot.entity?.position;
  if (!origin || !target?.position || !bot.blockAt) return false;
  const start = origin.offset(0, 1.5, 0);
  const end = target.position.offset(0, Math.min(target.height || 1.8, 1.5) * 0.75, 0);
  const distance = start.distanceTo(end);
  if (distance > 3.2) return false;
  const steps = Math.max(1, Math.ceil(distance / 0.1));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const block = bot.blockAt(start.offset((end.x - start.x) * t, (end.y - start.y) * t, (end.z - start.z) * t));
    // Conservative: do not swing through unknown blocks, fluids or partial shapes.
    if (!block || !['air', 'cave_air', 'void_air'].includes(block.name)) return false;
  }
  return true;
}

export class CombatController {
  constructor(bot, arbiter, emit, { now = Date.now } = {}) {
    Object.assign(this, { bot, arbiter, emit, now });
    this.active = false;
    this.busy = false;
    this.generation = 0;
    this.targetId = null;
    this.nextAt = 0;
    this.lastDecision = '';
    this.failures = new Map();
  }
  start() { this.active = true; this.generation++; this.targetId = null; this.nextAt = 0; this.lastDecision = ''; this.failures.clear(); }
  stop() { this.active = false; this.generation++; this.targetId = null; if (this.arbiter.current?.owner === 'combat') this.arbiter.cancel('combat_stopped'); }
  tick() {
    if (!this.active) return;
    const now = this.now();
    for (const [id, failure] of this.failures) if (failure.until && now >= failure.until) this.failures.delete(id);
    const snapshot = combatSnapshot(this.bot);
    const decision = selectCombat({ ...snapshot, entities: snapshot.entities.filter(e => !this.failures.get(e.id)?.until), currentTargetId: this.targetId });
    // Never filter emergency threats out of the decision model.
    if (snapshot.entities.some(e => e.name === 'creeper' && e.distance <= 4)) Object.assign(decision, { mode: 'EMERGENCY', reason: 'close_creeper', targetId: null });
    const signature = `${decision.mode}:${decision.targetId ?? ''}:${decision.reason}`;
    if (signature !== this.lastDecision) {
      this.lastDecision = signature;
      this.emit({ type: 'COMBAT-ARBITRATION', ...decision, weapon: snapshot.weapon?.item.name ?? null, health: snapshot.health });
    }
    if (decision.mode !== 'MELEE') {
      this.targetId = null;
      if (this.arbiter.current?.owner === 'combat') this.arbiter.cancel(decision.reason);
      return;
    }
    if (this.targetId !== decision.targetId && this.arbiter.current?.owner === 'combat') this.arbiter.cancel('target_changed');
    this.targetId = decision.targetId;
    if (this.busy || now < this.nextAt || this.arbiter.safetyFloor > 500) return;
    const targetId = this.targetId, generation = this.generation;
    const weapon = snapshot.weapon;
    this.busy = true;
    this.nextAt = now + 300;
    const validTarget = () => {
      if (!this.active || generation !== this.generation || this.targetId !== targetId) return null;
      const fresh = combatSnapshot(this.bot);
      const choice = selectCombat({ ...fresh, currentTargetId: targetId });
      return choice.mode === 'MELEE' && choice.targetId === targetId ? this.bot.entities[targetId] : null;
    };
    void this.arbiter.run('combat', 500, async ({ guard, signal }) => {
      let target = validTarget();
      if (!target) throw new Error('Target unavailable');
      if (this.bot.heldItem?.name !== weapon.item.name) await guard(() => this.bot.equip(weapon.item, 'hand'));
      guard(() => {});
      target = validTarget();
      if (!target) throw new Error('Target changed during equip');
      const position = this.bot.entity.position;
      const distance = position.distanceTo(target.position);
      if (distance > 2.8) {
        const dx = target.position.x - position.x, dz = target.position.z - position.z;
        const length = Math.hypot(dx, dz);
        if (length < 0.01) throw new Error('Unreachable elevation');
        const step = Math.min(0.8, Math.max(0, distance - 2.5));
        const destination = { x: position.x + dx / length * step, y: position.y, z: position.z + dz / length * step };
        if (!safeSegment(worldReader(this.bot), position, destination)) throw new Error('Unsafe approach');
        await executeEscape(this.bot, destination, { guard, signal }, { stillNeeded: () => !!validTarget() });
        return; // Re-observe and attack in a new session; never use pre-movement geometry.
      }
      await guard(() => this.bot.lookAt(target.position.offset(0, 1, 0), true));
      guard(() => {});
      target = validTarget();
      if (!target || this.bot.entity.position.distanceTo(target.position) > 2.8 || !clearMeleeLine(this.bot, target)) throw new Error('Final melee validation failed');
      if (this.bot.heldItem?.name !== weapon.item.name) throw new Error('Weapon changed');
      guard(() => this.bot.attack(target));
      this.nextAt = this.now() + weapon.cooldownMs;
      this.emit({ type: 'COMBAT-TRACE', targetId, response: 'attack_command_issued', weapon: weapon.item.name, hitConfirmed: false });
    }, 1800).then(result => {
      if (!this.active || generation !== this.generation) return;
      if (result.state === 'FAILED') {
        const count = (this.failures.get(targetId)?.count || 0) + 1;
        this.failures.set(targetId, { count, until: count >= 3 ? this.now() + 5000 : 0 });
      } else if (result.state === 'COMPLETED') this.failures.delete(targetId);
      if (result.state !== 'BLOCKED') this.emit({ type: 'COMBAT-RESULT', targetId, ...result });
    }).finally(() => { this.busy = false; });
  }
}
