import { catalog, validateGoal } from './goals.js';
import { AttemptLedger } from './attempts.js';
import { validateDecision } from './plans.js';
import { objectiveItems } from './objectives.js';

function stale(before, after, elapsed) {
  const moved = before.position && after.position && Math.hypot(after.position.x - before.position.x, after.position.y - before.position.y, after.position.z - before.position.z) > 2;
  return elapsed < 0 || elapsed > 30000 || after.dimension !== before.dimension || moved || after.health < before.health;
}

export class StrategyController {
  constructor({ provider, identity, observe, execute, emit, intervalMs = 300000, now = Date.now, memory = null, toolRegistry = null }) {
    Object.assign(this, { provider, identity, observe, execute, emit, intervalMs, now, memory, toolRegistry });
    this.attempts = new AttemptLedger({ now });
    this.active = false;
    this.busy = false;
    this.epoch = 0;
    this.recent = [];
    this.nextAt = 0;
    this.controller = null;
    this.pending = null;
    this.recovery = null;
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
      let resourceMemories = [];
      try { resourceMemories = this.memory?.retrieveResources?.(observation) || []; }
      catch { this.emit({ type: 'MEMORY-ERROR', code: 'resource_memory_read_failed' }); }
      let objective = null;
      try { objective = this.memory?.retrieveObjective?.(observation) || null; }
      catch { this.emit({ type: 'MEMORY-ERROR', code: 'objective_read_failed' }); }
      let goal;
      let source = 'local_fallback';
      if (this.provider) {
        try {
          goal = await this.provider.plan({ identity: this.identity, observation, tools: this.toolRegistry?.catalog() || catalog, recentResults: this.recent.slice(-5), memories, resourceMemories, objective, objectiveOptions: { items: objectiveItems, maxCount: 64 }, deferredAttempts: this.attempts.context(observation), planRecovery: this.recovery?.dimension === observation.dimension ? structuredClone(this.recovery) : null }, { signal: this.controller.signal });
          source = 'cloud';
        } catch (error) {
          if (this.active && epoch === this.epoch) this.emit({ type: 'STRATEGY-PROVIDER', code: ['missing_api_key', 'budget_exhausted', 'authentication_failed', 'network_or_timeout', 'cancelled', 'invalid_provider_output', 'provider_http_error'].includes(error.code) ? error.code : 'provider_unavailable' });
        }
      }
      // A safe read-only fallback does not invent long-term goals or movement.
      const proposed = goal || { tool: 'scan', args: {}, reason: 'Observe while cloud planning is unavailable.' };
      const allowedTools = this.toolRegistry ? this.toolRegistry.catalog().map(tool => tool.name) : catalog.map(tool => tool.name);
      const decision = validateDecision(proposed, allowedTools);
      const steps = decision.steps || [decision];
      let current = this.observe();
      if (!this.active || epoch !== this.epoch || stale(observation, current, this.now() - started)) {
        this.emit({ type: 'STRATEGY-DISCARD', reason: 'stale_context' }); return;
      }
      if (Object.hasOwn(decision, 'objective')) {
        if (this.memory) await this.remember('objective', current, { objective: decision.objective });
        else this.emit({ type: 'MEMORY-ERROR', code: 'objective_storage_unavailable' });
        current = this.observe();
        if (!this.active || epoch !== this.epoch || stale(observation, current, this.now() - started) || current.risk?.mode !== 'NORMAL' || !Number.isFinite(current.health) || !Number.isFinite(current.food) || current.food < 12) {
          this.emit({ type: 'STRATEGY-DISCARD', reason: 'stale_context' }); return;
        }
      }
      if (steps.length > 1) this.emit({ type: 'STRATEGY-PLAN', steps: steps.length });
      // Plans are ephemeral: no queue is kept after this tick, death or restart.
      // The 60-second deadline bounds admission of further steps; an already
      // running action retains its own (at most 15-second) arbiter timeout.
      for (let index = 0; index < steps.length; index++) {
        if (!this.active || epoch !== this.epoch) return;
        const stepObservation = index === 0 ? current : this.observe();
        if (index > 0 && (this.now() < started || this.now() - started >= 60000 || stepObservation.dimension !== observation.dimension || !Number.isFinite(stepObservation.health) || !Number.isFinite(stepObservation.food) || stepObservation.food < 12 || stepObservation.health < observation.health || stepObservation.risk?.mode !== 'NORMAL')) {
          this.recovery = { dimension: observation.dimension, completedSteps: index, stoppedTool: steps[index].tool, reason: 'context_changed', reobserveRequired: true };
          this.emit({ type: 'STRATEGY-PLAN-STOP', reason: 'context_changed', completedSteps: index }); return;
        }
        goal = this.toolRegistry ? this.toolRegistry.validate(steps[index]) : validateGoal(steps[index], catalog.map(tool => tool.name));
        const retryAfterMs = this.attempts.remaining(goal, stepObservation);
        let deferred = false;
        if (retryAfterMs > 0) {
          this.emit({ type: 'STRATEGY-DEFER', tool: goal.tool, reason: 'attempt_cooldown', retryAfterMs });
          goal = { tool: 'scan', args: {}, reason: 'Observe instead of repeating a recently unsuccessful action.' };
          goal = this.toolRegistry ? this.toolRegistry.validate(goal) : validateGoal(goal, catalog.map(tool => tool.name));
          deferred = true;
        }
        this.emit({ type: 'STRATEGY-GOAL', tool: goal.tool, source: deferred ? 'local_cooldown' : source });
        let result;
        try { result = await this.execute(goal); }
        catch { result = { state: 'FAILED', reason: 'execution_exception' }; }
        if (this.active && epoch === this.epoch) this.attempts.record(goal, stepObservation, result.state);
        // Only actually attempted steps become historical outcomes, never the
        // plan's unexecuted tail or arbitrary model rationale.
        await this.remember('goal_result', epoch === this.epoch ? this.observe() : stepObservation, { tool: goal.tool, state: result.state });
        if (steps.length > 1 && (result.state !== 'COMPLETED' || !this.active || epoch !== this.epoch)) this.recovery = { dimension: observation.dimension, completedSteps: index + (result.state === 'COMPLETED' ? 1 : 0), stoppedTool: goal.tool, reason: 'interrupted_or_failed', reobserveRequired: true };
        if (!this.active || epoch !== this.epoch) return;
        const record = { at: this.now(), tool: goal.tool, state: result.state };
        this.recent.push(record);
        if (this.recent.length > 30) this.recent.shift();
        this.emit({ type: 'STRATEGY-RESULT', ...record });
        if (deferred || result.state !== 'COMPLETED') {
          if (deferred && steps.length > 1) this.recovery = { dimension: observation.dimension, completedSteps: index, stoppedTool: steps[index].tool, reason: 'attempt_cooldown', reobserveRequired: true };
          if (steps.length > 1) this.emit({ type: 'STRATEGY-PLAN-STOP', reason: deferred ? 'attempt_cooldown' : 'step_not_completed', completedSteps: index });
          return;
        }
      }
      this.recovery = null;
      if (steps.length > 1) this.emit({ type: 'STRATEGY-PLAN-COMPLETE', steps: steps.length });
    } catch {
      this.emit({ type: 'STRATEGY-ERROR', code: 'planning_or_execution_failed' });
    } finally { this.busy = false; this.controller = null; }
  }
}
