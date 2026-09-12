import { catalog, validateGoal } from './goals.js';

export class StrategyController {
  constructor({ provider, identity, observe, execute, emit, intervalMs = 300000, now = Date.now, memory = null, toolRegistry = null }) {
    Object.assign(this, { provider, identity, observe, execute, emit, intervalMs, now, memory, toolRegistry });
    this.active = false;
    this.busy = false;
    this.epoch = 0;
    this.recent = [];
    this.nextAt = 0;
    this.controller = null;
    this.pending = null;
  }
  start() { this.active = true; this.epoch++; this.nextAt = this.now(); }
  stop() { this.active = false; this.epoch++; this.controller?.abort(); }
  invalidate() { this.epoch++; this.controller?.abort(); }
  tick() {
    if (!this.active || this.busy || this.now() < this.nextAt) return Promise.resolve();
    this.pending = this.runTick();
    return this.pending;
  }
  async settle() { await this.pending; }
  async remember(kind, observation, result) {
    if (!this.memory) return;
    try { await this.memory.remember(kind, observation, result); }
    catch { this.emit({ type: 'MEMORY-ERROR', code: 'memory_write_failed' }); }
  }
  async runTick() {
    this.busy = true;
    this.nextAt = this.now() + this.intervalMs;
    const epoch = this.epoch, started = this.now();
    this.controller = new AbortController();
    try {
      const observation = this.observe();
      // Take a bounded local-memory snapshot before querying the provider.
      let memories = [];
      try { memories = this.memory?.retrieve({ dimension: observation.dimension, position: observation.position }) || []; }
      catch { this.emit({ type: 'MEMORY-ERROR', code: 'memory_read_failed' }); }
      if (this.memory) await this.remember('observation', observation);
      if (!this.active || epoch !== this.epoch) return;
      let goal;
      let source = 'local_fallback';
      if (this.provider) {
        try {
          goal = await this.provider.plan({ identity: this.identity, observation, tools: this.toolRegistry?.catalog() || catalog, recentResults: this.recent.slice(-5), memories }, { signal: this.controller.signal });
          source = 'cloud';
        } catch (error) {
          if (this.active && epoch === this.epoch) this.emit({ type: 'STRATEGY-PROVIDER', code: ['missing_api_key', 'budget_exhausted', 'authentication_failed', 'network_or_timeout', 'cancelled', 'invalid_provider_output', 'provider_http_error'].includes(error.code) ? error.code : 'provider_unavailable' });
        }
      }
      // A safe read-only fallback does not invent long-term goals or movement.
      const proposed = goal || { tool: 'scan', args: {}, reason: 'Observe while cloud planning is unavailable.' };
      goal = this.toolRegistry ? this.toolRegistry.validate(proposed) : validateGoal(proposed, catalog.map(tool => tool.name));
      const current = this.observe();
      const moved = observation.position && current.position && Math.hypot(current.position.x - observation.position.x, current.position.y - observation.position.y, current.position.z - observation.position.z) > 2;
      if (!this.active || epoch !== this.epoch || this.now() - started > 30000 || current.dimension !== observation.dimension || moved || current.health < observation.health) {
        this.emit({ type: 'STRATEGY-DISCARD', reason: 'stale_context' }); return;
      }
      this.emit({ type: 'STRATEGY-GOAL', tool: goal.tool, source }); // Never log raw model text.
      const result = await this.execute(goal);
      // Interrupted goals remain historical outcomes, not resumable commands.
      await this.remember('goal_result', epoch === this.epoch ? this.observe() : observation, { tool: goal.tool, state: result.state });
      if (!this.active || epoch !== this.epoch) return;
      const record = { at: this.now(), tool: goal.tool, state: result.state };
      this.recent.push(record);
      if (this.recent.length > 30) this.recent.shift();
      this.emit({ type: 'STRATEGY-RESULT', ...record });
    } catch {
      this.emit({ type: 'STRATEGY-ERROR', code: 'planning_or_execution_failed' });
    } finally { this.busy = false; this.controller = null; }
  }
}
