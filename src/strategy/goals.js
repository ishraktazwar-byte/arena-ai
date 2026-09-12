export const catalog = Object.freeze([
  { name: 'scan', description: 'Observe current health, inventory and nearby entities.', args: {} },
  { name: 'wait', description: 'Wait briefly while local survival remains active.', args: { durationMs: 'integer 100..5000' } },
  { name: 'move_step', description: 'Walk one bounded cardinal step on validated flat ground.', args: { direction: 'north|south|east|west' } }
]);

export function validateGoal(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Goal must be an object');
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'args,reason,tool') throw new Error('Unexpected goal fields');
  if (typeof value.reason !== 'string' || value.reason.length > 240) throw new Error('Invalid goal reason');
  if (!value.args || Array.isArray(value.args) || typeof value.args !== 'object') throw new Error('Invalid goal arguments');
  const args = value.args;
  if (value.tool === 'scan' && Object.keys(args).length === 0) return { tool: value.tool, args: {}, reason: value.reason };
  if (value.tool === 'wait' && Object.keys(args).join(',') === 'durationMs' && Number.isInteger(args.durationMs) && args.durationMs >= 100 && args.durationMs <= 5000) return { tool: value.tool, args: { durationMs: args.durationMs }, reason: value.reason };
  if (value.tool === 'move_step' && Object.keys(args).join(',') === 'direction' && ['north', 'south', 'east', 'west'].includes(args.direction)) return { tool: value.tool, args: { direction: args.direction }, reason: value.reason };
  throw new Error('Unsupported tool or arguments');
}
