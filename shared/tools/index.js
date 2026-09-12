import { setTimeout as delay } from 'node:timers/promises';
import { executeEscape, safeSegment, worldReader } from '../../src/escape.js';
import { validateGoal } from '../../src/strategy/goals.js';

export async function executeGoal(bot, arbiter, proposed, { observe, emit = () => {} }) {
  const goal = validateGoal(proposed);
  if (goal.tool === 'scan') {
    // Read-only; it never owns or writes body controls.
    return { state: 'COMPLETED', observation: observe(bot) };
  }
  return arbiter.run('strategy', 100, async session => {
    if (goal.tool === 'wait') {
      await delay(goal.args.durationMs, undefined, { signal: session.signal });
      return;
    }
    const position = bot.entity?.position;
    if (!position || !bot.entity.onGround) throw new Error('No grounded body');
    const [dx, dz] = { north: [0, -0.8], south: [0, 0.8], east: [0.8, 0], west: [-0.8, 0] }[goal.args.direction];
    const destination = { x: position.x + dx, y: position.y, z: position.z + dz };
    if (!safeSegment(worldReader(bot), position, destination)) throw new Error('Unsafe or unknown strategic step');
    await executeEscape(bot, destination, session);
    emit({ type: 'GOAL-STEP', destination });
  }, goal.tool === 'wait' ? goal.args.durationMs + 500 : 1200);
}
