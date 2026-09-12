import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { ControlArbiter } from '../src/control.js';
import { assessRisk, selectFood, SurvivalController } from '../src/survival.js';
const base = { health: 20, food: 20, entities: [] };
function fixture() {
  let clock = 0;
  const events = [], calls = [];
  const bot = { health: 20, food: 10, entities: {}, inventory: { items: () => [{ name: 'bread', count: 2 }] }, equip: async () => calls.push('equip'), consume: async () => calls.push('consume') };
  const arbiter = new ControlArbiter(() => calls.push('stop'));
  const survival = new SurvivalController(bot, arbiter, e => events.push(e), { now: () => clock });
  survival.start();
  return { bot, arbiter, survival, events, calls, time: value => { clock = value; } };
}
test('distant creeper does not override nearby ordinary threat', () => {
  assert.equal(assessRisk({ ...base, entities: [{ name: 'creeper', distance: 18 }, { name: 'spider', distance: 5 }] }).mode, 'ALERT');
  assert.equal(assessRisk({ ...base, entities: [{ name: 'creeper', distance: 18 }] }).mode, 'NORMAL');
});
test('close creeper, hazard and low oxygen require emergency halt', () => {
  for (const extra of [{ entities: [{ name: 'creeper', distance: 4 }] }, { hazardousBlock: 'lava' }, { oxygen: 30 }]) assert.equal(assessRisk({ ...base, ...extra }).floor, 1000);
});
test('critical health permits recovery actions but blocks strategy', () => {
  assert.equal(assessRisk({ ...base, health: 4 }).floor, 500);
  assert.equal(assessRisk({ food: 10 }).reason, 'unknown_vitals');
});
test('food selection excludes harmful and special foods', () => {
  assert.equal(selectFood([{ name: 'rotten_flesh', count: 4 }, { name: 'pufferfish', count: 1 }]), null);
  assert.equal(selectFood([{ name: 'bread', count: 0 }, { name: 'apple', count: 1 }]).name, 'apple');
});
test('safe hunger triggers one eating session and cooldown prevents spam', async () => {
  const f = fixture();
  f.survival.tick(); f.survival.tick(); await settle();
  assert.equal(f.calls.filter(x => x === 'consume').length, 1);
  f.survival.tick(); await settle();
  assert.equal(f.calls.filter(x => x === 'consume').length, 1);
  f.time(5001); f.survival.tick(); await settle();
  assert.equal(f.calls.filter(x => x === 'consume').length, 2);
  f.survival.stop();
});
test('full hunger causes no eating and unchanged risk does not flood logs', () => {
  const f = fixture(); f.bot.food = 20;
  for (let i = 0; i < 100; i++) f.survival.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.events.length, 1);
  f.survival.stop();
});
test('missing safe food is diagnosed without repeated attempts', () => {
  const f = fixture(); f.bot.inventory.items = () => [];
  f.survival.tick(); f.survival.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.events[0].foodAvailable, false);
  assert.equal(f.events.length, 1);
  f.survival.stop();
});
test('emergency preempts strategy and gate prevents immediate restart', async () => {
  const f = fixture(); f.bot.food = 20;
  const pending = f.arbiter.run('strategy', 100, () => new Promise(() => {}));
  f.bot.oxygenLevel = 20; f.survival.tick();
  assert.equal((await pending).state, 'CANCELLED');
  assert.equal((await f.arbiter.run('strategy', 100, async () => {})).state, 'BLOCKED');
  f.bot.oxygenLevel = 300; f.time(500); f.survival.tick();
  assert.equal(f.arbiter.safetyFloor, 1000);
  f.time(1600); f.survival.tick();
  assert.equal((await f.arbiter.run('strategy', 100, async () => {})).state, 'COMPLETED');
  f.survival.stop();
});
test('death during delayed equip prevents later consume', async () => {
  const f = fixture(); let finish;
  f.bot.equip = () => new Promise(resolve => { finish = resolve; });
  f.survival.tick(); await settle();
  f.survival.stop(); finish(); await settle();
  assert.equal(f.calls.includes('consume'), false);
  assert.equal(f.events.some(e => e.type === 'SURVIVAL-EAT'), false);
  assert.equal(f.arbiter.current, null);
});
test('failed consume releases controls and retry is bounded', async () => {
  const f = fixture(); f.bot.consume = async () => { throw new Error('missing item'); };
  f.survival.tick(); await settle();
  assert.equal(f.events.find(e => e.type === 'SURVIVAL-EAT').state, 'FAILED');
  assert.equal(f.arbiter.current, null);
  f.survival.tick(); await settle();
  assert.equal(f.calls.filter(x => x === 'equip').length, 1);
  f.survival.stop();
});
test('nearby hostile defers eating even at critical health', () => {
  const f = fixture(); f.bot.health = 4;
  f.bot.entity = { position: { distanceTo: () => 5 } };
  f.bot.entities = { 1: { id: 1, name: 'zombie', position: { distanceTo: () => 5 } } };
  f.survival.tick();
  assert.equal(f.survival.busy, false);
  f.survival.stop();
});
