import { ControlArbiter } from './control.js';
import { SurvivalController } from './survival.js';
import { CombatController } from './combat.js';
import { StrategyController } from './strategy/controller.js';
import { executeGoal } from '../shared/tools/index.js';

export function observe(bot) {
  const position = bot.entity?.position;
  return {
    observedAt: new Date().toISOString(), health: bot.health ?? null, food: bot.food ?? null,
    oxygen: bot.oxygenLevel ?? null,
    position: position ? { x: position.x, y: position.y, z: position.z } : null,
    dimension: bot.game?.dimension ?? null, timeOfDay: bot.time?.timeOfDay ?? null,
    equippedItem: bot.heldItem?.name ?? null,
    inventory: bot.inventory?.items().map(item => ({ name: item.name, count: item.count })) ?? [],
    nearbyEntities: position ? Object.values(bot.entities || {}).filter(e => e !== bot.entity && e.position && e.position.distanceTo(position) <= 24).map(e => ({ id: e.id, name: e.name || e.username || 'unknown', distance: e.position.distanceTo(position), visibility: 'unverified' })) : []
  };
}

export function attachRuntime(bot, emit, { provider = null, identity = {}, aiIntervalMs = 300000 } = {}) {
  let ready = false;
  const stopBody = () => {
    bot.clearControlStates();
    bot.stopDigging();
    bot.deactivateItem();
  };
  let strategy;
  const arbiter = new ControlArbiter(stopBody, event => {
    if (event.type === 'ACTION' && event.state === 'RUNNING' && event.owner !== 'strategy') strategy?.invalidate();
    emit(event);
  });
  const survival = new SurvivalController(bot, arbiter, emit);
  const combat = new CombatController(bot, arbiter, emit);
  strategy = new StrategyController({ provider, identity, observe: () => observe(bot), execute: goal => executeGoal(bot, arbiter, goal, { observe, emit }), emit, intervalMs: aiIntervalMs });
  arbiter.setSafetyFloor(1000, 'not_spawned');
  bot.on('physicsTick', () => { if (ready) { survival.tick(); combat.tick(); if (arbiter.safetyFloor === 0 && !arbiter.current) void strategy.tick(); } });
  bot.on('spawn', () => { arbiter.cancel('spawn'); ready = true; survival.start(); combat.start(); strategy.start(); survival.tick(); emit({ type: 'SPAWN', observation: observe(bot) }); });
  bot.on('death', () => { ready = false; survival.stop(); combat.stop(); strategy.stop(); arbiter.cancel('death'); stopBody(); emit({ type: 'DEATH' }); });
  bot.on('end', () => { ready = false; survival.stop(); combat.stop(); strategy.stop(); arbiter.cancel('disconnect'); emit({ type: 'DISCONNECTED' }); });
  bot.on('health', () => { strategy.invalidate(); emit({ type: 'HEALTH', health: bot.health, food: bot.food }); });
  // Do not print raw provider/network errors or server-supplied text: they may contain secrets.
  bot.on('error', () => emit({ type: 'CONNECTION_ERROR', message: 'Connection error; verify server and authentication configuration.' }));
  bot.on('kicked', () => emit({ type: 'KICKED', message: 'Server rejected or ended the connection.' }));
  return {
    arbiter,
    status: () => ({ ready, observation: observe(bot) }),
    // Explicit operator-only smoke test. Not autonomous navigation or an idle-avoidance loop.
    async step() {
      if (!ready) return { state: 'BLOCKED', reason: 'not spawned' };
      return arbiter.run('operator-step', 10, async ({ signal, guard }) => {
        guard(() => bot.setControlState('forward', true));
        await new Promise(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, 250);
          signal.addEventListener('abort', done, { once: true });
        });
      }, 1000);
    },
    close() { ready = false; survival.stop(); combat.stop(); strategy.stop(); arbiter.cancel('shutdown'); stopBody(); bot.quit(); }
  };
}
