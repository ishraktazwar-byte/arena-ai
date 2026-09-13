import { permitsBlock } from '../permissions.js';
import { readBlock, isAir } from '../../shared/tools/resources.js';
import { checkTable, checkFurnace } from '../../shared/tools/workspace.js';
import { planCraft } from '../../shared/tools/craft.js';
import { TILLABLE, checkTilling, checkBasin, checkWaterSource, checkFarmPlacement, waterSource } from '../../shared/tools/farm-development.js';
import { hydration, growingConditions } from './growth.js';
import { FARM_CROPS } from './intent.js';
export function productionLayout(farm) {
  return { basin: { x: farm.x - 2, y: farm.y - 1, z: farm.z - 2 }, table: { x: farm.x - 2, y: farm.y, z: farm.z + 2 }, furnace: { x: farm.x + 2, y: farm.y, z: farm.z - 2 }, lampBase: { x: farm.x, y: farm.y, z: farm.z }, lamp: { x: farm.x, y: farm.y + 1, z: farm.z } };
}
export function reservedCell(farm, p) {
  if (!farm.develop) return false;
  const l = productionLayout(farm);
  return [l.table, l.furnace, l.lampBase].some(c => c.x === p.x && c.z === p.z) || Math.abs(l.basin.x - p.x) + Math.abs(l.basin.z - p.z) <= 1;
}
const usableTool = (bot, suffix) => bot.inventory.slots.slice(9, 45).some(item => item?.name.endsWith(`_${suffix}`) && (item.durabilityUsed ?? 0) < (bot.registry.itemsByName[item.name]?.maxDurability || 0) - 1);
const goal = (tool, args) => ({ tool, args, reason: 'Develop the chosen farm and verify current conditions.' });
const count = (bot, name) => bot.inventory.slots.slice(9, 45).reduce((n, item) => n + (item?.name === name ? item.count : 0), 0);
function craftGoal(bot, name, table) {
  try { planCraft(bot, name); return goal('craft', { item: name }); } catch (error) {
    if (error.code === 'crafting_table_window_required' && readBlock(bot, table)?.name === 'crafting_table') return goal('craft_at_table', { ...table, item: name });
    // Width-three recipes can only be proven after opening; the caller's bounded
    // attempt ledger prevents repeated missing-ingredient openings.
    if (readBlock(bot, table)?.name === 'crafting_table' && ['furnace', 'bucket', 'wooden_hoe', 'wooden_shovel', 'bread'].includes(name)) return goal('craft_at_table', { ...table, item: name });
  }
  return null;
}
export function chooseProduction(bot, farm, policies, approach, available, { growth = [], cookingPending = false, smeltingPending = false, probeCooking = false } = {}) {
  if (!farm.develop) return null;
  const l = productionLayout(farm), spec = FARM_CROPS[farm.crop];
  if (!policies.workspace?.enabled) return { status: 'production_workspace_disabled' };
  if (bot.game.dimension === 'the_nether') return { status: 'production_water_evaporates' };
  const ready = next => {
    if (!next || !available(next)) return null;
    try {
      if (next.tool === 'craft_at_table') checkTable(bot, next.args, policies.workspace);
      if (['cook_food', 'smelt_iron'].includes(next.tool)) checkFurnace(bot, next.args, policies.workspace);
      return next;
    } catch (error) {
      if (bot.food >= 12 && ['workspace_table_not_visible', 'workspace_elevation_unsupported', 'cooking_furnace_unreachable'].includes(error.code)) return approach(next.args);
      return null;
    }
  };
  const getCraft = name => ready(craftGoal(bot, name, l.table));
  if (bot.food < 12) {
    if (farm.crop === 'potatoes' && readBlock(bot, l.furnace)?.name === 'furnace') {
      const next = ready(goal('cook_food', { ...l.furnace, item: 'potato' }));
      if (next && (count(bot, 'potato') || cookingPending || probeCooking)) return { status: 'cooking_for_nutrition', goal: next };
    }
    if (farm.crop === 'wheat' && count(bot, 'wheat') >= 3) { const next = getCraft('bread'); if (next && available(next)) return { status: 'making_bread', goal: next }; }
    return { status: 'production_nutrition_shortage' };
  }
  const choose = (tool, args, check, status) => {
    const next = goal(tool, args);
    if (!available(next)) return { status: `${status}_cooldown` };
    try { check(); return { status, goal: next }; }
    catch (error) {
      if (['development_unreachable', 'development_body_column'].includes(error.code)) {
        const route = approach({ x: args.x, y: farm.y, z: args.z });
        if (route) return { status: `approaching_${status}`, goal: route };
      }
      return { status: error.code || `${status}_blocked` };
    }
  };
  const build = (p, name, policy) => {
    if (readBlock(bot, p)?.name === name) return null;
    if (!isAir(readBlock(bot, p))) return { status: `production_${name}_site_obstructed` };
    if (count(bot, name) < 1) {
      const craft = getCraft(name);
      return { status: `production_needs_${name}`, ...(craft && available(craft) ? { goal: craft } : {}) };
    }
    return choose('place_farm_block', { ...p, block: name }, () => checkFarmPlacement(bot, p, policy, name), `building_${name}`);
  };
  // Workstations first also permit smelting mined iron into bucket ingredients.
  const table = build(l.table, 'crafting_table', policies.workspace); if (table) return table;
  const furnace = build(l.furnace, 'furnace', policies.workspace); if (furnace) return furnace;
  const lampBase = build(l.lampBase, 'cobblestone', policies.farming); if (lampBase) return lampBase;
  const lamp = build(l.lamp, 'torch', policies.farming); if (lamp) return lamp;
  const needed = [];
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    const p = { x: farm.x + dx, y: farm.y, z: farm.z + dz };
    if (!reservedCell(farm, p) && permitsBlock(policies.farming, bot.game.dimension, p)) needed.push(p);
  }
  if (!needed.length) return { status: 'production_no_authorized_cells' };
  if (needed.some(p => hydration(bot, p).state !== 'covered')) {
    const basin = readBlock(bot, l.basin);
    if (!waterSource(basin)) {
      if (!count(bot, 'water_bucket')) {
        if (!count(bot, 'bucket')) {
          if ((count(bot, 'raw_iron') || smeltingPending || probeCooking) && count(bot, 'iron_ingot') < 3) {
            const smelt = ready(goal('smelt_iron', l.furnace));
            if (smelt) return { status: 'smelting_bucket_iron', goal: smelt };
          }
          const craft = getCraft('bucket');
          return { status: 'production_needs_bucket', ...(craft && available(craft) ? { goal: craft } : {}) };
        }
        const p = bot.entity.position;
        for (let dx = -4; dx <= 4; dx++) for (let dy = -1; dy <= 0; dy++) for (let dz = -4; dz <= 4; dz++) {
          const source = { x: Math.floor(p.x) + dx, y: Math.round(p.y) + dy, z: Math.floor(p.z) + dz };
          if (source.x === l.basin.x && source.y === l.basin.y && source.z === l.basin.z || !waterSource(readBlock(bot, source))) continue;
          const next = goal('fill_water_bucket', source); if (!available(next)) continue;
          try { checkWaterSource(bot, source, policies.farming); return { status: 'obtaining_water', goal: next }; } catch (error) {
            if (error.code === 'development_unreachable') { const route = approach({ ...source, y: farm.y }); if (route) return { status: 'approaching_water', goal: route }; }
          }
        }
        return { status: 'production_needs_safe_water_source' };
      }
      if (!isAir(basin)) {
        if (!usableTool(bot, 'shovel')) {
          const craft = getCraft('wooden_shovel');
          return { status: 'production_needs_shovel', ...(craft && available(craft) ? { goal: craft } : {}) };
        }
        return choose('dig_irrigation', l.basin, () => checkBasin(bot, l.basin, policies.farming), 'excavating_irrigation');
      }
      return choose('irrigate_basin', l.basin, () => checkBasin(bot, l.basin, policies.farming, { dug: true }), 'irrigating');
    }
    return { status: 'production_hydration_unknown' };
  }
  for (const p of needed) {
    const soil = readBlock(bot, { ...p, y: p.y - 1 });
    if (TILLABLE.has(soil?.name) && isAir(readBlock(bot, p))) {
      if (!usableTool(bot, 'hoe')) {
        const craft = getCraft('wooden_hoe');
        return { status: 'production_needs_hoe', ...(craft && available(craft) ? { goal: craft } : {}) };
      }
      const target = { ...p, y: p.y - 1 };
      return choose('till_soil', target, () => checkTilling(bot, target, policies.farming), 'tilling');
    }
  }
  // Food processing does not assume a furnace has finished. The action reports
  // input/fuel/processing/output phases and each later open is fresh.
  const plantingFloor = farm.reserve + needed.filter(p => isAir(readBlock(bot, p)) && readBlock(bot, { ...p, y: p.y - 1 })?.name === 'farmland').length;
  if (farm.crop === 'potatoes' && (count(bot, 'potato') > plantingFloor || cookingPending || probeCooking)) {
    const next = ready(goal('cook_food', { ...l.furnace, item: 'potato' }));
    if (next) return { status: 'cooking', goal: next };
  }
  if (farm.crop === 'wheat' && count(bot, 'wheat') >= 3) {
    const next = getCraft('bread');
    if (next && available(next)) return { status: 'making_bread', goal: next };
  }
  const stalled = growth.find(v => v.suspectedStall && v.recoveryAllowed && v.light === 'lit' && v.moisture > 0 && count(bot, 'bone_meal') > 0 && v.age < spec.age);
  if (stalled) {
    const next = goal('fertilize_crop', stalled.position);
    if (available(next)) return { status: 'recovering_stalled_growth', goal: next };
  }
  const unknown = needed.filter(p => readBlock(bot, { ...p, y: p.y - 1 })?.name === 'farmland').map(p => growingConditions(bot, p)).find(v => v.light !== 'lit');
  if (unknown) return { status: unknown.light === 'unknown' ? 'production_lighting_unknown' : 'production_waiting_for_light_update' };
  return null;
}

// Bounded, read-only site proposals let strategy choose a location from observed
// ordinary ground. They are not construction approvals or promised materials.
export function scanProductionSites(bot, farming, workspace) {
  const origin = bot.entity?.position, dimension = bot.game?.dimension;
  if (!farming?.enabled || !workspace?.enabled || !origin || ![origin.x, origin.y, origin.z].every(Number.isFinite) || dimension === 'the_nether') return [];
  const candidates = [], found = [], y = Math.round(origin.y);
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) candidates.push({ x: Math.floor(origin.x) + dx, y, z: Math.floor(origin.z) + dz });
  candidates.sort((a, b) => Math.hypot(a.x + 0.5 - origin.x, a.z + 0.5 - origin.z) - Math.hypot(b.x + 0.5 - origin.x, b.z + 0.5 - origin.z));
  for (const p of candidates) {
    let suitable = true;
    for (let dx = -2; dx <= 2 && suitable; dx++) for (let dz = -2; dz <= 2 && suitable; dz++) {
      const cell = { x: p.x + dx, y, z: p.z + dz }, soil = { ...cell, y: y - 1 };
      suitable = permitsBlock(farming, dimension, cell) && permitsBlock(farming, dimension, soil) && isAir(readBlock(bot, cell)) && TILLABLE.has(readBlock(bot, soil)?.name);
    }
    const layout = productionLayout(p);
    if (!suitable || ![layout.table, layout.furnace].every(cell => permitsBlock(workspace, dimension, cell))) continue;
    found.push({ ...p, ground: 'loaded_ordinary_soil', constructionRecheckRequired: true, resourcesGuaranteed: false });
    if (found.length === 8) break;
  }
  return found;
}
