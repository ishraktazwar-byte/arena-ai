import { craftItems } from './craft.js';
// Trusted built-in schemas. The active registry determines which are advertised.
export const definitions = Object.freeze({
  scan: { description: 'Observe health, inventory, entities and visible nearby resources.', args: {} },
  wait: { description: 'Wait briefly while local survival remains active.', args: { durationMs: 'integer 100..5000' } },
  navigate_local: { description: 'Navigate to the center of an empty x,z cell on the current floor, within six blocks and the deployment-authorized world or area. Known flat terrain only; at most twelve short legs. Does not mine, jump or collect intentionally.', args: { x: 'integer block coordinate', z: 'integer block coordinate' } },
  move_step: { description: 'Walk one bounded cardinal step on validated flat ground.', args: { direction: 'north|south|east|west' } },
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
  if (tool === 'scan' || tool === 'scan_resources' || tool === 'craft_options' || tool === 'workspace_options' || tool === 'scan_items') return keys === '';
  if (tool === 'navigate_local') return keys === 'x,z' && ['x', 'z'].every(key => Number.isInteger(args[key]) && Math.abs(args[key]) <= 30000000);
  if (tool === 'wait') return keys === 'durationMs' && Number.isInteger(args.durationMs) && args.durationMs >= 100 && args.durationMs <= 5000;
  if (tool === 'move_step') return keys === 'direction' && ['north', 'south', 'east', 'west'].includes(args.direction);
  if (tool === 'craft') return keys === 'item' && craftItems.includes(args.item);
  if (tool === 'place_crafting_table' || tool === 'craft_at_table') return keys === (tool === 'place_crafting_table' ? 'x,y,z' : 'item,x,y,z') && ['x', 'y', 'z'].every(k => Number.isInteger(args[k]) && Math.abs(args[k]) <= 30000000) && args.y >= -64 && args.y <= 319 && (tool !== 'craft_at_table' || craftItems.includes(args.item));
  if (tool === 'collect_items') return keys === 'entityId,entityUuid,expectedItem' && Number.isInteger(args.entityId) && args.entityId >= 0 && args.entityId <= 2147483647 && typeof args.entityUuid === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(args.entityUuid) && typeof args.expectedItem === 'string' && /^[a-z0-9_]{1,64}$/.test(args.expectedItem);
  if (tool === 'mine') return keys === 'expectedBlock,x,y,z' && ['x', 'y', 'z'].every(k => Number.isInteger(args[k]) && Math.abs(args[k]) <= 30000000) && args.y >= -64 && args.y <= 319 && typeof args.expectedBlock === 'string' && /^[a-z_]{1,64}$/.test(args.expectedBlock);
  return false;
}
