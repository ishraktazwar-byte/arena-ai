import { craftItems } from '../../shared/tools/craft.js';

// A deliberately finite vocabulary, not arbitrary text or an executable task.
export const objectiveItems = Object.freeze([...new Set([...craftItems, 'cobblestone', 'coal', 'raw_iron', 'bread', 'carrot', 'apple', 'cooked_beef', 'baked_potato', 'wheat', 'potato', 'beetroot', 'wheat_seeds', 'beetroot_seeds'])]);
export const OBJECTIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export function validObjective(value) {
  return value === null || (!!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === 'count,item' && objectiveItems.includes(value.item) && Number.isInteger(value.count) && value.count >= 1 && value.count <= 64);
}
export function assessObjective(record, observation, now) {
  if (!record || !record.data.objective || now < record.at || now - record.at >= OBJECTIVE_MAX_AGE_MS) return null;
  const objective = record.data.objective;
  const inventory = observation.inventory;
  const known = observation.inventoryKnown !== false && Array.isArray(inventory) && inventory.length <= 46 && Array.from(inventory).every(item => item && typeof item.name === 'string' && /^[a-z0-9_]{1,64}$/.test(item.name) && Number.isInteger(item.count) && item.count > 0 && item.count <= 64);
  const observedCount = known ? inventory.reduce((sum, item) => sum + (item.name === objective.item ? item.count : 0), 0) : null;
  return { ...objective, observedCount, state: !known ? 'unknown' : observedCount >= objective.count ? 'satisfied_now' : 'active', ageMs: now - record.at, source: 'cloud_intent', inventoryEvidence: 'local_observation', requiresFreshPlan: true };
}
