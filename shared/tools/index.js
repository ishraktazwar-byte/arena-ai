import { setTimeout as delay } from 'node:timers/promises';
import { executeEscape, safeSegment, worldReader } from '../../src/escape.js';
import { validateGoal } from '../../src/strategy/goals.js';
import { definitions } from './definitions.js';
import { scanResources } from './resources.js';
import { mineBlock, MiningError } from './mine.js';
import { craftOne, craftOptions, CraftError } from './craft.js';
import { inspectWorkspaces, placeTable, craftAtTable, WorkspaceError } from './workspace.js';
import { collectItems, scanItems, CollectionError } from './collect.js';

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
    let toolReason;
    const result = await arbiter.run('strategy', 100, async session => {
      try { return await tool.run(bot, goal.args, session, { ...context, arbiter }); }
      catch (error) { if (error instanceof MiningError || error instanceof CraftError || error instanceof WorkspaceError || error instanceof CollectionError) toolReason = error.code; throw error; }
    }, tool.timeoutMs);
    if (toolReason && result.state === 'FAILED') result.reason = toolReason;
    if (goal.tool === 'mine' || goal.tool === 'craft') context.emit?.({ type: goal.tool === 'mine' ? 'MINING-RESULT' : 'CRAFT-RESULT', state: result.state, reason: result.reason ?? null, result: result.result ?? null });
    if (goal.tool === 'place_crafting_table' || goal.tool === 'craft_at_table') context.emit?.({ type: 'WORKSPACE-RESULT', tool: goal.tool, ...result });
    if (goal.tool === 'collect_items') context.emit?.({ type: 'COLLECTION-RESULT', ...result });
    return result;
  }
}
export function createToolRegistry({ miningPolicy = { enabled: false }, workspacePolicy = { enabled: false }, collectionPolicy = { enabled: false } } = {}) {
  const registry = new ToolRegistry();
  registry.register('scan', { readOnly: true, run: (bot, args, session, { observe }) => ({ observation: observe(bot) }) });
  registry.register('scan_resources', { readOnly: true, run: bot => ({ resources: scanResources(bot) }) });
  registry.register('craft_options', { readOnly: true, run: bot => craftOptions(bot) });
  registry.register('craft', { timeoutMs: 15000, run: (bot, args, session) => craftOne(bot, args, session) });
  const workspace = structuredClone(workspacePolicy);
  registry.register('workspace_options', { readOnly: true, run: bot => inspectWorkspaces(bot, workspace) });
  if (workspace.enabled) {
    const constraints = { dimension: workspace.dimension, area: workspace.area };
    registry.register('place_crafting_table', { timeoutMs: 8000, constraints, run: (bot, args, session) => placeTable(bot, args, workspace, session) });
    registry.register('craft_at_table', { timeoutMs: 15000, constraints, run: (bot, args, session, context) => craftAtTable(bot, args, workspace, session, context) });
  }
  const collection = structuredClone(collectionPolicy);
  registry.register('scan_items', { readOnly: true, run: bot => scanItems(bot, collection) });
  if (collection.enabled) registry.register('collect_items', { timeoutMs: 10000, constraints: { dimension: collection.dimension, area: collection.area, maxDistance: 4, maxSteps: 5 }, run: (bot, args, session) => collectItems(bot, args, collection, session) });
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
