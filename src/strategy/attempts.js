import { validateGoal } from './goals.js';

const READ_ONLY = new Set(['scan', 'scan_resources', 'craft_options', 'workspace_options', 'scan_items']);
const LIMIT = 64;
const RETENTION_MS = 60 * 60 * 1000;
const BASE_MS = 10 * 60 * 1000;
const MAX_MS = 30 * 60 * 1000;
function identity(goal, observation) {
  validateGoal(goal);
  const args = Object.fromEntries(Object.keys(goal.args).sort().map(key => [key, key === 'entityUuid' ? goal.args[key].toLowerCase() : goal.args[key]]));
  const p = observation.position;
  const cell = p && ['x', 'y', 'z'].every(key => Number.isFinite(p[key]) && Math.abs(p[key]) <= 30000000) ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null;
  const dimension = typeof observation.dimension === 'string' && /^[a-zA-Z0-9_:.-]{1,160}$/.test(observation.dimension) ? observation.dimension : null;
  return { key: JSON.stringify([dimension, cell, goal.tool, args]), dimension, cell, tool: goal.tool, args };
}

// Per-controller, bounded, in-memory retry suppression. This is not a safety
// permission, a durable world fact, or evidence that a failed action did nothing.
export class AttemptLedger {
  constructor({ now = Date.now } = {}) { this.now = now; this.records = new Map(); }
  prune() {
    const now = this.now();
    for (const [key, record] of this.records) if (now < record.at || now - record.at >= RETENTION_MS) this.records.delete(key);
  }
  remaining(goal, observation) {
    this.prune();
    if (READ_ONLY.has(goal.tool)) return 0;
    const record = this.records.get(identity(goal, observation).key);
    return record ? Math.max(0, record.until - this.now()) : 0;
  }
  record(goal, observation, state) {
    this.prune();
    if (READ_ONLY.has(goal.tool) || !['FAILED', 'BLOCKED', 'COMPLETED'].includes(state)) return;
    const value = identity(goal, observation);
    if (state === 'COMPLETED') { this.records.delete(value.key); return; }
    const failures = Math.min(3, (this.records.get(value.key)?.failures || 0) + 1);
    this.records.delete(value.key);
    this.records.set(value.key, { ...value, failures, at: this.now(), until: this.now() + Math.min(MAX_MS, BASE_MS * 2 ** (failures - 1)), state });
    while (this.records.size > LIMIT) this.records.delete(this.records.keys().next().value);
  }
  context(observation) {
    this.prune();
    const scope = identity({ tool: 'scan', args: {}, reason: '' }, observation);
    return [...this.records.values()].filter(record => record.dimension === scope.dimension && record.until > this.now()).slice(-8).reverse().map(record => ({
      tool: record.tool, args: structuredClone(record.args), originCell: structuredClone(record.cell), state: record.state,
      failures: record.failures, retryAfterMs: Math.max(0, record.until - this.now())
    }));
  }
}
