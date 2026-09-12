import { randomUUID } from 'node:crypto';

// Every body write must pass through the current session's guard.
export class ControlArbiter {
  constructor(stopBody, emit = () => {}) {
    this.stopBody = stopBody;
    this.emit = emit;
    this.current = null;
    this.safetyFloor = 0;
  }
  setSafetyFloor(priority, reason) {
    this.safetyFloor = priority;
    if (this.current && this.current.priority < priority) this.cancel(reason);
  }
  cleanup(session) {
    if (session.cleaned) return;
    session.cleaned = true;
    for (const cleanup of session.cleanups) {
      try { cleanup(); } catch { this.emit({ type: 'ACTION_CLEANUP_ERROR', sessionId: session.id }); }
    }
    session.cleanups.length = 0;
  }
  releaseBody(session) {
    try { this.stopBody(); } catch { this.emit({ type: 'BODY_CLEANUP_ERROR', sessionId: session.id }); }
    this.cleanup(session);
  }
  cancel(reason = 'cancelled') {
    const session = this.current;
    if (!session) return;
    this.current = null; // Revoke ownership before cleanup or callbacks.
    session.state = 'CANCELLED';
    session.cancelReason = reason;
    session.controller.abort(reason);
    this.releaseBody(session);
    this.emit({ type: 'ACTION', sessionId: session.id, state: session.state, reason });
  }
  async run(owner, priority, execute, timeoutMs = 10000) {
    if (!Number.isFinite(priority) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid session limits');
    if (priority < this.safetyFloor) return { state: 'BLOCKED', reason: 'safety_gate' };
    if (this.current && priority <= this.current.priority) return { state: 'BLOCKED' };
    this.cancel('preempted');
    const session = { id: randomUUID(), owner, priority, state: 'RUNNING', cleanups: [], cleaned: false, startedAt: Date.now(), controller: new AbortController() };
    this.current = session;
    const signal = session.controller.signal;
    const guard = fn => {
      if (signal.aborted || this.current !== session) throw new Error('Session no longer owns body');
      return fn();
    };
    const addCleanup = fn => guard(() => {
      if (typeof fn !== 'function') throw new Error('Cleanup must be synchronous callable');
      session.cleanups.push(fn);
    });
    const timer = setTimeout(() => { if (this.current === session) this.cancel('timeout'); }, timeoutMs);
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new Error('Action cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    this.emit({ type: 'ACTION', sessionId: session.id, owner, state: 'RUNNING' });
    try {
      const result = await Promise.race([Promise.resolve().then(() => execute({ signal, guard, addCleanup, sessionId: session.id })), aborted]);
      if (signal.aborted) return { state: 'CANCELLED', reason: session.cancelReason };
      session.state = 'COMPLETED';
      return result === undefined ? { state: 'COMPLETED' } : { state: 'COMPLETED', result };
    } catch {
      session.state = signal.aborted ? 'CANCELLED' : 'FAILED';
      return { state: session.state, reason: session.cancelReason || 'execution failed' };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (this.current === session) { this.current = null; this.releaseBody(session); }
      this.emit({ type: 'ACTION_RESULT', sessionId: session.id, state: session.state });
    }
  }
}

// Cross-dimension permission must not make an in-flight action cross bodies or
// worlds. A new planning cycle may use a new dimension; an old action may not.
export function bindBodySession(bot, session, changedError) {
  const entity = bot.entity, dimension = bot.game?.dimension;
  return { ...session, guard: fn => session.guard(() => {
    if (bot.entity !== entity || bot.game?.dimension !== dimension) throw changedError();
    return fn();
  }) };
}
