import { validateGoal } from './goals.js';
import { definitions } from '../../shared/tools/definitions.js';

export const MAX_PLAN_STEPS = 4;
// Backwards-compatible single goals or an explicit, bounded sequence. No loops,
// branches, generated code, dynamic argument substitution or resumable commands.
export function validateDecision(value, allowedTools = Object.keys(definitions)) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid decision');
  if (!Object.hasOwn(value, 'steps')) return validateGoal(value, allowedTools);
  if (Object.keys(value).sort().join(',') !== 'reason,steps' || typeof value.reason !== 'string' || value.reason.length > 240 || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > MAX_PLAN_STEPS) throw new Error('Invalid plan');
  return { reason: value.reason, steps: Array.from(value.steps, step => validateGoal(step, allowedTools)) };
}
export function decisionSteps(value, allowedTools) {
  const decision = validateDecision(value, allowedTools);
  return decision.steps || [decision];
}
