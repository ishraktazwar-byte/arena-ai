import { setTimeout as delay } from 'node:timers/promises';
import { executeEscape, safeSegment, worldReader } from '../../src/escape.js';
import { validateGoal } from '../../src/strategy/goals.js';
import { definitions } from './definitions.js';
import { scanResources } from './resources.js';
import { mineBlock, MiningError } from './mine.js';

export class ToolRegistry {
  constructor() { this.tools = new Map(); }
  register(name, { run, readOnly = false, timeoutMs = 10000, constraints = null }) {
    if (!Object.hasOwn(definitions, name) || this.tools.has(name) || typeof run !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 15000) throw new Error('Invalid tool registration');
    this.tools.set(name, { run, readOnly, timeoutMs, constraints: structuredClone(constraints) });
    return this;
  }
  catalog() { return [...this.tools].map(([name, tool]) => structuredClone({ name, ...definitions[name], ...(tool.constraints ? { constraints: tool.constraints } : {}) })); }
  validate(proposed) { return validateGoal(proposed, [...this.tools.keys()]); }
  async execute(bot, arbiter, proposed, context) {
    const goal = this.validate(proposed);
    const tool = this.tools.get(goal.tool);
    if (tool.readOnly) return { state: 'COMPLETED', result: await tool.run(bot, goal.args, null, context) };
    let miningReason;
    const result = await arbiter.run('strategy', 100, async session => {
      try { return await tool.run(bot, goal.args, session, context); }
      catch (error) { if (error instanceof MiningError) miningReason = error.code; throw error; }
    }, tool.timeoutMs);
    if (miningReason && result.state === 'FAILED') result.reason = miningReason;
    if (goal.tool === 'mine') context.emit?.({ type: 'MINING-RESULT', state: result.state, reason: result.reason ?? null, result: result.result ?? null });
    return result;
  }
}
export function createToolRegistry({ miningPolicy = { enabled: false } } = {}) {
  const registry = new ToolRegistry();
  registry.register('scan', { readOnly: true, run: (bot, args, session, { observe }) => ({ observation: observe(bot) }) });
  registry.register('scan_resources', { readOnly: true, run: bot => ({ resources: scanResources(bot) }) });
  registry.register('wait', { timeoutMs: 5500, run: (bot, args, { signal }) => delay(args.durationMs, undefined, { signal }) });
  registry.register('move_step', { timeoutMs: 1200, run: async (bot, args, session, { emit = () => {} }) => {
    const position = bot.entity?.position;
    if (!position || !bot.entity.onGround) throw new Error('No grounded body');
    const [dx, dz] = { north: [0, -0.8], south: [0, 0.8], east: [0.8, 0], west: [-0.8, 0] }[args.direction];
    const destination = { x: position.x + dx, y: position.y, z: position.z + dz };
    if (!safeSegment(worldReader(bot), position, destination)) throw new Error('Unsafe or unknown strategic step');
    await executeEscape(bot, destination, session);
    emit({ type: 'GOAL-STEP', destination });
  } });
  if (miningPolicy.enabled) {
    // Freeze a snapshot of permission; model arguments cannot alter the area.
    const policy = structuredClone(miningPolicy);
    registry.register('mine', { timeoutMs: 12000, constraints: { dimension: policy.dimension, area: policy.area }, run: (bot, args, session) => mineBlock(bot, args, policy, session) });
  }
  return registry;
}
const defaultRegistry = createToolRegistry();
export async function executeGoal(bot, arbiter, proposed, context) {
  return (context.registry || defaultRegistry).execute(bot, arbiter, proposed, context);
}
