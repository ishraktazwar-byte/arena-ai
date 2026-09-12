// Trusted built-in schemas. The active registry determines which are advertised.
export const definitions = Object.freeze({
  scan: { description: 'Observe health, inventory, entities and visible nearby resources.', args: {} },
  wait: { description: 'Wait briefly while local survival remains active.', args: { durationMs: 'integer 100..5000' } },
  move_step: { description: 'Walk one bounded cardinal step on validated flat ground.', args: { direction: 'north|south|east|west' } },
  scan_resources: { description: 'List at most 16 line-of-sight resource blocks within four blocks; does not move or mine.', args: {} },
  mine: { description: 'Attempt one visible resource block inside the operator-approved mining area. No approach, tunneling or automatic repeat.', args: { x: 'integer block coordinate', y: 'integer block coordinate -64..319', z: 'integer block coordinate', expectedBlock: 'exact resource block name from observation' } }
});
export function validArgs(tool, args) {
  if (!args || Array.isArray(args) || typeof args !== 'object') return false;
  const keys = Object.keys(args).sort().join(',');
  if (tool === 'scan' || tool === 'scan_resources') return keys === '';
  if (tool === 'wait') return keys === 'durationMs' && Number.isInteger(args.durationMs) && args.durationMs >= 100 && args.durationMs <= 5000;
  if (tool === 'move_step') return keys === 'direction' && ['north', 'south', 'east', 'west'].includes(args.direction);
  if (tool === 'mine') return keys === 'expectedBlock,x,y,z' && ['x', 'y', 'z'].every(k => Number.isInteger(args[k]) && Math.abs(args[k]) <= 30000000) && args.y >= -64 && args.y <= 319 && typeof args.expectedBlock === 'string' && /^[a-z_]{1,64}$/.test(args.expectedBlock);
  return false;
}
