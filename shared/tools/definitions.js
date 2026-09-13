import { COOKING } from './cook.js';
import { FARM_BLOCKS } from './farm-development.js';
import { validFarm } from '../../src/farming/intent.js';
import { cropAges } from './farm.js';
import { craftItems } from './craft.js';
// Trusted built-in schemas. The active registry determines which are advertised.
export const definitions = Object.freeze({
  scan: { description: 'Observe health, inventory, entities and visible nearby resources.', args: {} },
  wait: { description: 'Wait briefly while local survival remains active.', args: { durationMs: 'integer 100..5000' } },
  establish_farm: { description: 'Choose a complete farm-production goal on suitable nearby dirt/grass or farmland: construct contained irrigation, till, light, plant, harvest and process food. Uses carried or craftable materials and observed renewable water, never creates resources. Reserves plot corners for workstations/water and center for a lamp. Same crop/stock/reserve fields as manage_farm.', args: { x: 'integer center x', y: 'integer crop height', z: 'integer center z', crop: 'wheat|carrots|potatoes|beetroots', targetStock: 'integer 1..64', reserve: 'integer 1..64' } },
  till_soil: { description: 'Hoe one suitable dirt/grass/path block to farmland (coarse dirt first becomes dirt). Requires carried usable hoe and empty space above, checks server transformation.', args: { x: 'integer soil x', y: 'integer soil y', z: 'integer soil z' } },
  dig_irrigation: { description: 'Excavate one dirt/grass irrigation pocket outside the body footprint. Requires shovel, known full bottom and four full inert walls; never digs open channels.', args: { x: 'integer soil x', y: 'integer soil y', z: 'integer soil z' } },
  fill_water_bucket: { description: 'Fill a carried empty bucket from an observed source with two adjacent sources and renewable support. Requires server removal and exact bucket inventory conversion.', args: { x: 'integer water x', y: 'integer water y', z: 'integer water z' } },
  irrigate_basin: { description: 'Empty a carried water bucket into a verified contained single-cell pocket, with water-source and inventory evidence. Never in the Nether or into open channels.', args: { x: 'integer pocket x', y: 'integer pocket y', z: 'integer pocket z' } },
  place_farm_block: { description: 'Place one carried cobblestone, crafting table, furnace or standing torch at an empty cell with safe support and exit. Workspace scope gates tables/furnaces; farming scope gates lamp supports/torches.', args: { x: 'integer x', y: 'integer y', z: 'integer z', block: 'cobblestone|crafting_table|furnace|torch' } },
  fertilize_crop: { description: 'Apply one carried bone meal to an immature supported crop; require a server age increase and verified consumption. No growth guarantee.', args: { x: 'integer crop x', y: 'integer crop y', z: 'integer crop z' } },
  cook_food: { description: 'One bounded furnace phase: load one food, add one coal/charcoal if needed, inspect processing, or recover verified cooked output. Never equates loading with cooked food; protects planting reserves.', args: { x: 'integer furnace x', y: 'integer furnace y', z: 'integer furnace z', item: Object.keys(COOKING).join('|') } },
  smelt_iron: { description: 'One guarded furnace phase for raw iron into iron ingots, allowing a bucket to be crafted. Same fuel, output and cancellation checks as cooking.', args: { x: 'integer furnace x', y: 'integer furnace y', z: 'integer furnace z' } },
  manage_farm: { description: 'Persist a maintenance goal for existing farmland in a 5x5 plot centered at x,y,z (y is crop height). Choose crop, desired produce stock and protected planting-item reserve (each 1..64). Local workers collect yield, refill empty cells, harvest ripe crops and recover from interruption using fresh observations. No tilling, irrigation or guaranteed yield.', args: { x: 'integer center x', y: 'integer crop y -63..319', z: 'integer center z', crop: 'wheat|carrots|potatoes|beetroots', targetStock: 'integer 1..64', reserve: 'integer 1..64' } },
  stop_farm: { description: 'Abandon the current dimension farm-maintenance intention and release its planting-item reserve.', args: {} },
  navigate_farm: { description: 'Walk a bounded route through known full ground, farmland and non-colliding crops. Handles 1/16-block soil edges without jumping or sprinting; navigation permission still required.', args: { x: 'integer block coordinate', z: 'integer block coordinate' } },
  navigate_local: { description: 'Navigate to the center of an empty x,z cell on the current floor, within six blocks and the deployment-authorized world or area. Known flat terrain only; at most twelve short legs. Does not mine, jump or collect intentionally.', args: { x: 'integer block coordinate', z: 'integer block coordinate' } },
  move_step: { description: 'Walk one bounded cardinal step on validated flat ground.', args: { direction: 'north|south|east|west' } },
  collect_nearby: { description: 'Collect one freshly observed nearby dropped stack of the requested item where collection policy permits. Can follow mining or harvesting without knowing future entity IDs. Waits at most one second for discovery, then binds one stable identity. No origin/ownership or complete-yield claim; conservative flat-ground movement only.', args: { expectedItem: 'Minecraft item name' } },
  scan_crops: { description: 'Observe at most 16 visible wheat, carrot, potato or beetroot plants, including maturity and local harvest eligibility, plus up to eight empty farmland planting sites with carried seed options. Does not move, harvest or plant.', args: {} },
  plant_crop: { description: 'Plant one supported crop in an observed empty cell above farmland where farming policy permits. Uses carried seed/produce, guarded hand staging, server seedling and inventory evidence. No walking or tilling.', args: { x: 'integer block coordinate', y: 'integer block coordinate -64..319', z: 'integer block coordinate', crop: 'wheat|carrots|potatoes|beetroots' } },
  harvest_crop: { description: 'Harvest one currently mature crop where farming policy permits, using an empty hand and server removal evidence. Does not walk, replant or claim drops collected.', args: { x: 'integer block coordinate', y: 'integer block coordinate -64..319', z: 'integer block coordinate', expectedCrop: 'wheat|carrots|potatoes|beetroots' } },
  scan_resources: { description: 'List at most 16 line-of-sight resource blocks within four blocks; does not move or mine.', args: {} },
  craft_options: { description: 'List bounded starter recipes available in main inventory; indicate recipes needing an open crafting-table window.', args: {} },
  craft: { description: 'Craft one starter recipe batch using main inventory ingredients. Requires clean grid/cursor; table recipes require an already-open crafting window.', args: { item: craftItems.join('|') } },
  workspace_options: { description: 'List nearby visible crafting tables and passing placement candidates where the deployment policy permits.', args: {} },
  place_crafting_table: { description: 'Place one carried crafting table on inert ground where the deployment policy permits; requires empty destination and server confirmation. Does not walk.', args: { x: 'integer block coordinate', y: 'integer block coordinate -64..319', z: 'integer block coordinate' } },
  craft_at_table: { description: 'Open one visible policy-authorized crafting table with empty hand, craft one starter batch, then close the owned window. Does not walk or place a table.', args: { x: 'integer block coordinate', y: 'integer block coordinate -64..319', z: 'integer block coordinate', item: craftItems.join('|') } },
  scan_items: { description: 'Observe at most 16 visible dropped-item stacks within four blocks; report UUID, item name and pickup eligibility. Ownership is not observable.', args: {} },
  collect_items: { description: 'Attempt pickup of one specified dropped-item stack where the deployment policy permits collection. Up to five short flat-ground steps; requires pickup and inventory evidence.', args: { entityId: 'integer entity ID 0..2147483647', entityUuid: 'exact UUID from scan_items', expectedItem: 'exact item name from scan_items' } },
  mine: { description: 'Attempt one visible resource block where the deployment policy permits mining. No approach, tunneling or automatic repeat.', args: { x: 'integer block coordinate', y: 'integer block coordinate -64..319', z: 'integer block coordinate', expectedBlock: 'exact resource block name from observation' } }
});
export function validArgs(tool, args) {
  if (!args || Array.isArray(args) || typeof args !== 'object') return false;
  const keys = Object.keys(args).sort().join(',');
  if (tool === 'scan' || tool === 'scan_resources' || tool === 'craft_options' || tool === 'workspace_options' || tool === 'scan_items' || tool === 'scan_crops') return keys === '';
  if (tool === 'navigate_local' || tool === 'navigate_farm') return keys === 'x,z' && ['x', 'z'].every(key => Number.isInteger(args[key]) && Math.abs(args[key]) <= 30000000);
  if (tool === 'wait') return keys === 'durationMs' && Number.isInteger(args.durationMs) && args.durationMs >= 100 && args.durationMs <= 5000;
  if (tool === 'move_step') return keys === 'direction' && ['north', 'south', 'east', 'west'].includes(args.direction);
  if (tool === 'craft') return keys === 'item' && craftItems.includes(args.item);
  if (tool === 'place_crafting_table' || tool === 'craft_at_table') return keys === (tool === 'place_crafting_table' ? 'x,y,z' : 'item,x,y,z') && ['x', 'y', 'z'].every(k => Number.isInteger(args[k]) && Math.abs(args[k]) <= 30000000) && args.y >= -64 && args.y <= 319 && (tool !== 'craft_at_table' || craftItems.includes(args.item));
  if (tool === 'manage_farm' || tool === 'establish_farm') return validFarm(args) && !Object.hasOwn(args, 'develop');
  if (['till_soil', 'dig_irrigation', 'fill_water_bucket', 'irrigate_basin', 'place_farm_block', 'fertilize_crop', 'cook_food', 'smelt_iron'].includes(tool)) {
    if (!['x', 'y', 'z'].every(k => Number.isInteger(args[k]) && Math.abs(args[k]) <= 29999997) || args.y < -63 || args.y > 318) return false;
    return tool === 'place_farm_block' ? keys === 'block,x,y,z' && FARM_BLOCKS.includes(args.block) : tool === 'cook_food' ? keys === 'item,x,y,z' && Object.hasOwn(COOKING, args.item) : keys === 'x,y,z';
  }
  if (tool === 'stop_farm') return keys === '';
  if (tool === 'collect_nearby') return keys === 'expectedItem' && typeof args.expectedItem === 'string' && /^[a-z0-9_]{1,64}$/.test(args.expectedItem);
  if (tool === 'collect_items') return keys === 'entityId,entityUuid,expectedItem' && Number.isInteger(args.entityId) && args.entityId >= 0 && args.entityId <= 2147483647 && typeof args.entityUuid === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(args.entityUuid) && typeof args.expectedItem === 'string' && /^[a-z0-9_]{1,64}$/.test(args.expectedItem);
  if (tool === 'plant_crop') return keys === 'crop,x,y,z' && ['x', 'y', 'z'].every(k => Number.isInteger(args[k]) && Math.abs(args[k]) <= 30000000) && args.y >= -64 && args.y <= 319 && typeof args.crop === 'string' && Object.hasOwn(cropAges, args.crop);
  if (tool === 'harvest_crop') return keys === 'expectedCrop,x,y,z' && ['x', 'y', 'z'].every(k => Number.isInteger(args[k]) && Math.abs(args[k]) <= 30000000) && args.y >= -64 && args.y <= 319 && typeof args.expectedCrop === 'string' && Object.hasOwn(cropAges, args.expectedCrop);
  if (tool === 'mine') return keys === 'expectedBlock,x,y,z' && ['x', 'y', 'z'].every(k => Number.isInteger(args[k]) && Math.abs(args[k]) <= 30000000) && args.y >= -64 && args.y <= 319 && typeof args.expectedBlock === 'string' && /^[a-z_]{1,64}$/.test(args.expectedBlock);
  return false;
}
