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
  cancel(reason = 'cancelled') {
    const session = this.current;
    if (!session) return;
    this.current = null; // Revoke ownership before cleanup or callbacks.
    session.state = 'CANCELLED';
    session.cancelReason = reason;
    session.controller.abort(reason);
    this.stopBody();
    this.emit({ type: 'ACTION', sessionId: session.id, state: session.state, reason });
  }
  async run(owner, priority, execute, timeoutMs = 10000) {
    if (!Number.isFinite(priority) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid session limits');
    if (priority < this.safetyFloor) return { state: 'BLOCKED', reason: 'safety_gate' };
    if (this.current && priority <= this.current.priority) return { state: 'BLOCKED' };
    this.cancel('preempted');
    const session = { id: randomUUID(), owner, priority, state: 'RUNNING', startedAt: Date.now(), controller: new AbortController() };
    this.current = session;
    const signal = session.controller.signal;
    const guard = fn => {
      if (signal.aborted || this.current !== session) throw new Error('Session no longer owns body');
      return fn();
    };
    const timer = setTimeout(() => { if (this.current === session) this.cancel('timeout'); }, timeoutMs);
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new Error('Action cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    this.emit({ type: 'ACTION', sessionId: session.id, owner, state: 'RUNNING' });
    try {
      await Promise.race([Promise.resolve().then(() => execute({ signal, guard, sessionId: session.id })), aborted]);
      if (signal.aborted) return { state: 'CANCELLED', reason: session.cancelReason };
      session.state = 'COMPLETED';
      return { state: 'COMPLETED' };
    } catch {
      session.state = signal.aborted ? 'CANCELLED' : 'FAILED';
      return { state: session.state, reason: session.cancelReason || 'execution failed' };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (this.current === session) { this.current = null; this.stopBody(); }
      this.emit({ type: 'ACTION_RESULT', sessionId: session.id, state: session.state });
    }
  }
}
