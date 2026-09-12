import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { bestMelee, selectCombat, clearMeleeLine, CombatController } from '../src/combat.js';
import { ControlArbiter } from '../src/control.js';
const sword = { name: 'iron_sword', count: 1 };
const weapon = bestMelee([sword]);
const enemy = (id, name, distance) => ({ id, name, distance, verticalDifference: 0 });
const decide = (entities, extra = {}) => selectCombat({ health: 20, food: 20, weapon, entities, ...extra });
function vector(x, y, z) { return { x, y, z, offset(dx, dy, dz) { return vector(x + dx, y + dy, z + dz); }, distanceTo(p) { return Math.hypot(x - p.x, y - p.y, z - p.z); } }; }
function fixture() {
  let clock = 0;
  const calls = [], events = [];
  const target = { id: 1, name: 'skeleton', height: 1.8, isValid: true, position: vector(2.5, 64, 0.5) };
  const bot = {
    health: 20, food: 20, entity: { position: vector(0.5, 64, 0.5), onGround: true },
    entities: { 1: target }, inventory: { items: () => [sword] }, heldItem: sword,
    blockAt: p => p.y >= 64 ? { name: 'air' } : { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] },
    lookAt: async () => {}, equip: async item => { bot.heldItem = item; }, attack: e => calls.push(e.id)
  };
  const arbiter = new ControlArbiter(() => {});
  const combat = new CombatController(bot, arbiter, e => events.push(e), { now: () => clock });
  combat.start();
  return { bot, target, combat, arbiter, calls, events, time: t => { clock = t; } };
}
for (const name of ['spider', 'zombie', 'husk', 'skeleton', 'stray', 'pillager']) test(`healthy agent selects melee for nearby ${name}`, () => {
  assert.equal(decide([enemy(1, name, 2)]).mode, 'MELEE');
});
test('distant creeper does not hijack spider; close creeper does', () => {
  assert.equal(decide([enemy(1, 'spider', 5), enemy(2, 'creeper', 18)]).targetId, 1);
  assert.equal(decide([enemy(1, 'spider', 5), enemy(2, 'creeper', 4)]).mode, 'EMERGENCY');
});
test('target retained despite another ordinary enemy moving slightly closer', () => {
  assert.equal(decide([enemy(1, 'zombie', 4), enemy(2, 'spider', 3)], { currentTargetId: 1 }).targetId, 1);
  assert.equal(decide([enemy(2, 'spider', 3)], { currentTargetId: 1 }).targetId, 2);
});
test('low health, unavailable weapons and distant targets do not trigger melee', () => {
  assert.equal(decide([enemy(1, 'zombie', 2)], { health: 4 }).mode, 'FLEE');
  assert.equal(decide([enemy(1, 'zombie', 2)], { weapon: null }).mode, 'IDLE');
  assert.equal(decide([enemy(1, 'skeleton', 12)]).mode, 'IDLE');
});
test('melee equipment selection permits emergency tools, not arbitrary inventory items', () => {
  assert.equal(bestMelee([{ name: 'dirt', count: 64 }]), null);
  assert.equal(bestMelee([{ name: 'diamond_pickaxe', count: 1 }]).item.name, 'diamond_pickaxe');
  assert.equal(bestMelee([{ name: 'iron_axe', count: 1 }, sword]).item.name, 'iron_sword');
});
test('wall or unknown geometry prevents swing', () => {
  const f = fixture();
  assert.equal(clearMeleeLine(f.bot, f.target), true);
  f.bot.blockAt = () => ({ name: 'stone' });
  assert.equal(clearMeleeLine(f.bot, f.target), false);
  f.bot.blockAt = () => null;
  assert.equal(clearMeleeLine(f.bot, f.target), false);
  f.combat.stop();
});
test('close skeleton attack respects cooldown and does not claim a hit', async () => {
  const f = fixture();
  f.combat.tick(); await settle();
  assert.deepEqual(f.calls, [1]);
  f.combat.tick(); await settle(); assert.equal(f.calls.length, 1);
  f.time(701); f.combat.tick(); await settle(); assert.equal(f.calls.length, 2);
  assert.equal(f.events.find(e => e.type === 'COMBAT-TRACE').hitConfirmed, false);
  f.combat.stop();
});
test('death during delayed equip cannot lead to a stale attack', async () => {
  const f = fixture(); let finish;
  f.bot.heldItem = null;
  f.bot.equip = () => new Promise(resolve => { finish = resolve; });
  f.combat.tick(); await settle();
  f.bot.health = 0; f.combat.stop(); finish(); await settle();
  assert.equal(f.calls.length, 0);
  assert.equal(f.arbiter.current, null);
});
test('target removed while aiming prevents stale attack', async () => {
  const f = fixture(); let finish;
  f.bot.lookAt = () => new Promise(resolve => { finish = resolve; });
  f.combat.tick(); await settle();
  f.bot.entities = {}; finish(); await settle();
  assert.equal(f.calls.length, 0);
  f.combat.stop();
});
test('creeper arriving during aim cancels melee', async () => {
  const f = fixture(); let finish;
  f.bot.lookAt = () => new Promise(resolve => { finish = resolve; });
  f.combat.tick(); await settle();
  f.bot.entities[2] = { id: 2, name: 'creeper', position: vector(3, 64, 0.5) };
  f.combat.tick(); finish(); await settle();
  assert.equal(f.calls.length, 0);
  assert.equal(f.arbiter.current, null);
  f.combat.stop();
});
test('three failed final validations temporarily suppress an unreachable target', async () => {
  const f = fixture(); f.bot.blockAt = () => ({ name: 'stone' });
  for (let i = 0; i < 3; i++) { f.time(i * 400); f.combat.tick(); await settle(); }
  assert.ok(f.combat.failures.get(1).until > 0);
  f.time(1300); f.combat.tick();
  assert.equal(f.combat.targetId, null);
  f.time(6000); f.combat.tick(); await settle();
  assert.equal(f.combat.targetId, 1);
  f.combat.stop();
});
