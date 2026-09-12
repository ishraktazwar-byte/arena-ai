import { catalog, validateGoal } from './goals.js';

export class StrategyController {
  constructor({ provider, identity, observe, execute, emit, intervalMs = 300000, now = Date.now }) {
    Object.assign(this, { provider, identity, observe, execute, emit, intervalMs, now });
    this.active = false;
    this.busy = false;
    this.epoch = 0;
    this.recent = [];
    this.nextAt = 0;
    this.controller = null;
  }
  start() { this.active = true; this.epoch++; this.nextAt = this.now(); }
  stop() { this.active = false; this.epoch++; this.controller?.abort(); }
  invalidate() { this.epoch++; this.controller?.abort(); }
  async tick() {
    if (!this.active || this.busy || this.now() < this.nextAt) return;
    this.busy = true;
    this.nextAt = this.now() + this.intervalMs;
    const epoch = this.epoch, started = this.now();
    this.controller = new AbortController();
    try {
      const observation = this.observe();
      let goal;
      let source = 'local_fallback';
      if (this.provider) {
        try {
          goal = await this.provider.plan({ identity: this.identity, observation, tools: catalog, recentResults: this.recent.slice(-5) }, { signal: this.controller.signal });
          source = 'cloud';
        } catch (error) {
          if (this.active && epoch === this.epoch) this.emit({ type: 'STRATEGY-PROVIDER', code: ['missing_api_key', 'budget_exhausted', 'authentication_failed', 'network_or_timeout', 'cancelled', 'invalid_provider_output', 'provider_http_error'].includes(error.code) ? error.code : 'provider_unavailable' });
        }
      }
      // A safe read-only fallback does not invent long-term goals or movement.
      goal = validateGoal(goal || { tool: 'scan', args: {}, reason: 'Observe while cloud planning is unavailable.' });
      const current = this.observe();
      const moved = observation.position && current.position && Math.hypot(current.position.x - observation.position.x, current.position.y - observation.position.y, current.position.z - observation.position.z) > 2;
      if (!this.active || epoch !== this.epoch || this.now() - started > 30000 || current.dimension !== observation.dimension || moved || current.health < observation.health) {
        this.emit({ type: 'STRATEGY-DISCARD', reason: 'stale_context' }); return;
      }
      this.emit({ type: 'STRATEGY-GOAL', tool: goal.tool, source }); // Never log raw model text.
      const result = await this.execute(goal);
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
