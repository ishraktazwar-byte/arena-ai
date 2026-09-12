import { definitions, validArgs } from '../../shared/tools/definitions.js';

// Conservative fallback for controllers without a runtime registry (e.g. tests).
export const catalog = Object.freeze(Object.entries(definitions).filter(([name]) => name !== 'mine').map(([name, definition]) => ({ name, ...definition })));
export function validateGoal(value, allowedTools = Object.keys(definitions)) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Goal must be an object');
  if (Object.keys(value).sort().join(',') !== 'args,reason,tool') throw new Error('Unexpected goal fields');
  if (typeof value.reason !== 'string' || value.reason.length > 240) throw new Error('Invalid goal reason');
  if (!allowedTools.includes(value.tool) || !Object.hasOwn(definitions, value.tool) || !validArgs(value.tool, value.args)) throw new Error('Unsupported tool or arguments');
  return { tool: value.tool, args: structuredClone(value.args), reason: value.reason };
}
