import { tillSoil, digIrrigation, fillWaterBucket, irrigateBasin, placeFarmBlock, fertilizeCrop } from './farm-development.js';
import { cookFood } from './cook.js';
import { plantCrop } from './plant.js';
import { scanCrops, harvestCrop, FarmingError } from './farm.js';
import { permissionConstraints } from '../../src/permissions.js';
import { setTimeout as delay } from 'node:timers/promises';
import { executeEscape, safeSegment, worldReader } from '../../src/escape.js';
import { validateGoal } from '../../src/strategy/goals.js';
import { definitions } from './definitions.js';
import { scanResources } from './resources.js';
import { mineBlock, MiningError } from './mine.js';
import { craftOne, craftOptions, CraftError } from './craft.js';
import { inspectWorkspaces, placeTable, craftAtTable, WorkspaceError } from './workspace.js';
import { collectItems, collectNearby, scanItems, CollectionError } from './collect.js';
import { navigateLocal, NavigationError } from './navigate.js';

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
      catch (error) { if (error instanceof MiningError || error instanceof CraftError || error instanceof WorkspaceError || error instanceof CollectionError || error instanceof NavigationError || error instanceof FarmingError) toolReason = error.code; throw error; }
    }, tool.timeoutMs);
    if (toolReason && result.state === 'FAILED') result.reason = toolReason;
    if (goal.tool === 'mine' || goal.tool === 'craft') context.emit?.({ type: goal.tool === 'mine' ? 'MINING-RESULT' : 'CRAFT-RESULT', state: result.state, reason: result.reason ?? null, result: result.result ?? null });
    if (goal.tool === 'place_crafting_table' || goal.tool === 'craft_at_table') context.emit?.({ type: 'WORKSPACE-RESULT', tool: goal.tool, ...result });
    if (goal.tool === 'collect_items' || goal.tool === 'collect_nearby') context.emit?.({ type: 'COLLECTION-RESULT', tool: goal.tool, ...result });
    if ((goal.tool === 'navigate_local' || goal.tool === 'navigate_farm')) context.emit?.({ type: 'NAVIGATION-RESULT', ...result });
    if (['harvest_crop', 'plant_crop', 'till_soil', 'dig_irrigation', 'fill_water_bucket', 'irrigate_basin', 'place_farm_block', 'fertilize_crop', 'cook_food', 'smelt_iron'].includes(goal.tool)) context.emit?.({ type: 'FARMING-RESULT', tool: goal.tool, ...result });
    return result;
  }
}
export function createToolRegistry({ miningPolicy = { enabled: false }, workspacePolicy = { enabled: false }, collectionPolicy = { enabled: false }, navigationPolicy = { enabled: false }, farmingPolicy = { enabled: false }, farmManagement = false } = {}) {
  const registry = new ToolRegistry();
  registry.register('scan', { readOnly: true, run: (bot, args, session, { observe }) => ({ observation: observe(bot) }) });
  registry.register('scan_resources', { readOnly: true, run: bot => ({ resources: scanResources(bot) }) });
  registry.register('craft_options', { readOnly: true, run: bot => craftOptions(bot) });
  registry.register('craft', { timeoutMs: 15000, run: (bot, args, session) => craftOne(bot, args, session) });
  const workspace = structuredClone(workspacePolicy);
  registry.register('workspace_options', { readOnly: true, run: bot => inspectWorkspaces(bot, workspace) });
  if (workspace.enabled) {
    const constraints = permissionConstraints(workspace);
    registry.register('place_crafting_table', { timeoutMs: 8000, constraints, run: (bot, args, session) => placeTable(bot, args, workspace, session) });
    registry.register('craft_at_table', { timeoutMs: 15000, constraints, run: (bot, args, session, context) => craftAtTable(bot, args, workspace, session, context) });
  }
  const collection = structuredClone(collectionPolicy);
  registry.register('scan_items', { readOnly: true, run: bot => scanItems(bot, collection) });
  if (collection.enabled) registry.register('collect_items', { timeoutMs: 10000, constraints: { ...permissionConstraints(collection), maxDistance: 4, maxSteps: 5 }, run: (bot, args, session) => collectItems(bot, args, collection, session) });
  if (collection.enabled) registry.register('collect_nearby', { timeoutMs: 12000, constraints: { ...permissionConstraints(collection), maxDistance: 4, maxSteps: 5, maxTargets: 1, discoveryWaitMs: 1000 }, run: (bot, args, session) => collectNearby(bot, args, collection, session) });
  const navigation = structuredClone(navigationPolicy);
  if (navigation.enabled) registry.register('navigate_local', { timeoutMs: 15000, constraints: { ...permissionConstraints(navigation), maxDistance: 6, maxLegs: 12 }, run: (bot, args, session) => navigateLocal(bot, args, navigation, session) });
  if (navigation.enabled) registry.register('navigate_farm', { timeoutMs: 15000, constraints: { ...permissionConstraints(navigation), maxDistance: 6, maxLegs: 12 }, run: (bot, args, session) => navigateLocal(bot, args, navigation, session, { farmTerrain: true }) });
  const farming = structuredClone(farmingPolicy);
  registry.register('scan_crops', { readOnly: true, run: bot => scanCrops(bot, farming) });
  if (farming.enabled) registry.register('harvest_crop', { timeoutMs: 6000, constraints: { ...permissionConstraints(farming), maxDistance: 4, maxCrops: 1 }, run: (bot, args, session) => harvestCrop(bot, args, farming, session) });
  if (farming.enabled) registry.register('plant_crop', { timeoutMs: 12000, constraints: { ...permissionConstraints(farming), maxDistance: 4, maxPlants: 1 }, run: (bot, args, session) => plantCrop(bot, args, farming, session) });
  if (farming.enabled) for (const [name, run] of Object.entries({ till_soil: tillSoil, dig_irrigation: digIrrigation, fill_water_bucket: fillWaterBucket, irrigate_basin: irrigateBasin, fertilize_crop: fertilizeCrop })) registry.register(name, { timeoutMs: 14000, constraints: permissionConstraints(farming), run: (bot, args, session) => run(bot, args, farming, session) });
  if (farming.enabled || workspace.enabled) registry.register('place_farm_block', { timeoutMs: 14000, constraints: { farming: permissionConstraints(farming), workspace: permissionConstraints(workspace) }, run: (bot, args, session) => placeFarmBlock(bot, args, ['furnace', 'crafting_table'].includes(args.block) ? workspace : farming, session) });
  if (workspace.enabled) {
    registry.register('cook_food', { timeoutMs: 15000, constraints: permissionConstraints(workspace), run: (bot, args, session, context) => cookFood(bot, args, workspace, session, context) });
    registry.register('smelt_iron', { timeoutMs: 15000, constraints: permissionConstraints(workspace), run: (bot, args, session, context) => cookFood(bot, { ...args, item: 'raw_iron' }, workspace, session, context) });
  }
  if (farmManagement) {
    const configure = (bot, args, session, context) => {
      if (!context.farms) throw new FarmingError('farm_manager_unavailable');
      return context.farms.setGoal(args, session);
    };
    if (farming.enabled && collection.enabled && navigation.enabled) registry.register('manage_farm', { timeoutMs: 5000, constraints: { ...permissionConstraints(farming), plotWidth: 5 }, run: configure });
    if (farming.enabled && collection.enabled && navigation.enabled && workspace.enabled) registry.register('establish_farm', { timeoutMs: 5000, constraints: { ...permissionConstraints(farming), plotWidth: 5 }, run: (bot, args, session, context) => configure(bot, { ...args, develop: true }, session, context) });
    registry.register('stop_farm', { timeoutMs: 5000, run: (bot, args, session, context) => configure(bot, null, session, context) });
  }
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
    registry.register('mine', { timeoutMs: 12000, constraints: permissionConstraints(policy), run: (bot, args, session) => mineBlock(bot, args, policy, session) });
  }
  return registry;
}
const defaultRegistry = createToolRegistry();
export async function executeGoal(bot, arbiter, proposed, context) {
  return (context.registry || defaultRegistry).execute(bot, arbiter, proposed, context);
}
