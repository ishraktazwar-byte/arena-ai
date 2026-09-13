import { selectFood } from '../survival.js';

const PICKAXES = new Set(['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite'].map(material => `${material}_pickaxe`));
const vital = value => Number.isFinite(value) && value >= 0 && value <= 20;
const entry = (id, score, owner, evidence) => ({ id, score, status: score === null ? 'unknown' : score === 0 ? 'satisfied' : score >= 70 ? 'urgent' : 'needed', owner, evidence });

// Advisory motivations, not a task sequence or authority to run a tool. Supply
// counts describe carried items only: no ownership, durability or future yield.
export function assessNeeds(observation) {
  const health = vital(observation.health) ? observation.health : null;
  const food = vital(observation.food) ? observation.food : null;
  const risk = ['NORMAL', 'ALERT', 'RECOVER', 'HALT'].includes(observation.risk?.mode) ? observation.risk.mode : 'UNKNOWN';
  const inventoryKnown = observation.inventoryKnown !== false && Array.isArray(observation.inventory) && observation.inventory.length <= 46 && observation.inventory.every(item => item && /^[a-z0-9_]{1,64}$/.test(item.name || '') && Number.isInteger(item.count) && item.count > 0 && item.count <= 64);
  const items = inventoryKnown ? observation.inventory : [];
  const safeFoodUnits = inventoryKnown ? [...new Set(items.filter(item => selectFood([item])).map(item => item.name))].reduce((sum, name) => {
    const reserved = observation.seedReserves?.[name];
    const count = items.reduce((n, item) => n + (item.name === name ? item.count : 0), 0);
    return sum + Math.max(0, count - (Number.isInteger(reserved) && reserved >= 0 && reserved <= 64 ? reserved : 0));
  }, 0) : null;
  const pickaxesCarried = inventoryKnown ? items.reduce((sum, item) => sum + (PICKAXES.has(item.name) ? item.count : 0), 0) : null;
  const rawEmpty = observation.inventoryCapacity?.emptyNormalSlots;
  const emptyNormalSlots = Number.isInteger(rawEmpty) && rawEmpty >= 0 && rawEmpty <= 36 ? rawEmpty : null;
  const p = observation.position;
  const positionKnown = !!p && ['x', 'y', 'z'].every(key => Number.isFinite(p[key]) && Math.abs(p[key]) <= 30000000);
  const entries = [
    entry('safety', risk !== 'NORMAL' || health === null || food === null || !positionKnown ? 100 : 0, 'local_reflex', { risk, positionKnown }),
    entry('recovery', health === null ? null : Math.min(90, (20 - health) * 5), 'local_reflex', { health }),
    entry('nutrition', food === null ? null : (20 - food) * 5, 'local_reflex', { food }),
    entry('food_reserve', safeFoodUnits === null ? null : Math.max(0, 4 - safeFoodUnits) * 15, 'strategy', { safeFoodUnits, targetUnits: 4 }),
    entry('inventory_space', emptyNormalSlots === null ? null : emptyNormalSlots === 0 ? 80 : emptyNormalSlots < 3 ? 30 : 0, 'strategy', { emptyNormalSlots }),
    entry('gathering_tool', pickaxesCarried === null ? null : pickaxesCarried === 0 ? 25 : 0, 'strategy', { pickaxesCarried, usability: 'not_assessed' })
  ];
  // Stable sorting keeps local safety ahead of equally urgent supply/vital needs.
  entries.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return { advisoryOnly: true, policyVersion: 1, entries };
}
