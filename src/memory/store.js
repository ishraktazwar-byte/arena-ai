import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA = 3; // v1/v2 are read-compatible; crafting outcomes require v3 on write.
const LIMIT = 500;
const MAX_BYTES = 2 * 1024 * 1024;
const KINDS = new Set(['spawn', 'death', 'observation', 'goal_result']);
const STATES = new Set(['COMPLETED', 'BLOCKED', 'CANCELLED', 'FAILED']);
const TOOLS = new Set(['scan', 'wait', 'move_step', 'scan_resources', 'mine', 'craft_options', 'craft']); // Historical names remain readable even if a tool is disabled.
const label = value => typeof value === 'string' && /^[a-zA-Z0-9_:.-]{1,160}$/.test(value);
const keysAre = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === expected.sort().join(',');
const coordinate = p => p === null || (keysAre(p, ['x', 'y', 'z']) && Object.values(p).every(n => Number.isFinite(n) && Math.abs(n) <= 30000000));

export class MemoryError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function validRecord(record) {
  if (!keysAre(record, ['id', 'at', 'worldId', 'dimension', 'position', 'kind', 'source', 'data'])) return false;
  if (typeof record.id !== 'string' || !/^[0-9a-f-]{36}$/.test(record.id) || !Number.isSafeInteger(record.at) || record.at < 0) return false;
  if (!label(record.worldId) || !(record.dimension === null || label(record.dimension)) || !coordinate(record.position) || !KINDS.has(record.kind)) return false;
  if (record.kind === 'goal_result') return record.source === 'local_execution' && keysAre(record.data, ['tool', 'state']) && TOOLS.has(record.data.tool) && STATES.has(record.data.state);
  return record.source === 'local_observation' && keysAre(record.data, ['health', 'food']) && ['health', 'food'].every(key => record.data[key] === null || (Number.isFinite(record.data[key]) && record.data[key] >= 0 && record.data[key] <= 20));
}

async function load(path, agent) {
  if ((await stat(path)).size > MAX_BYTES) throw new MemoryError('memory_corrupt');
  const raw = await readFile(path, 'utf8');
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new MemoryError('memory_corrupt');
  let envelope;
  try { envelope = JSON.parse(raw); } catch { throw new MemoryError('memory_corrupt'); }
  if (Number.isInteger(envelope?.schemaVersion) && ![1, 2, SCHEMA].includes(envelope.schemaVersion)) throw new MemoryError('memory_schema_unsupported');
  if (!keysAre(envelope, ['schemaVersion', 'agent', 'records']) || ![1, 2, SCHEMA].includes(envelope.schemaVersion) || envelope.agent !== agent || !Array.isArray(envelope.records) || envelope.records.length > LIMIT || !envelope.records.every(validRecord)) throw new MemoryError('memory_corrupt');
  if (new Set(envelope.records.map(r => r.id)).size !== envelope.records.length) throw new MemoryError('memory_corrupt');
  return envelope.records;
}

// All writes are serialized inside one process; a per-agent lock excludes
// a second process. Never write arbitrary model text, chat or environment data.
export class MemoryStore {
  static async open({ directory, agent, worldId, now = Date.now }) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agent) || !label(worldId)) throw new MemoryError('memory_identity_invalid');
    await mkdir(directory, { recursive: true });
    const store = new MemoryStore(directory, agent, worldId, now);
    try { await mkdir(store.lock); } catch (error) { throw new MemoryError(error.code === 'EEXIST' ? 'memory_locked' : 'memory_open_failed'); }
    try {
      try { store.records = await load(store.path, agent); }
      catch (error) {
        if (error.code === 'memory_schema_unsupported') throw error;
        if (!['ENOENT', 'memory_corrupt'].includes(error.code)) throw new MemoryError('memory_read_failed');
        try {
          store.records = await load(store.backup, agent);
          store.recovered = true;
          // Repair the primary from the validated backup without replacing it.
          await store.atomicWrite(store.path, store.records);
        } catch (backupError) {
          if (error.code === 'ENOENT' && backupError.code === 'ENOENT') store.records = [];
          else throw new MemoryError(backupError.code === 'memory_schema_unsupported' ? backupError.code : 'memory_recovery_failed');
        }
      }
      return store;
    } catch (error) {
      await rm(store.lock, { recursive: true, force: true });
      throw error;
    }
  }
  constructor(directory, agent, worldId, now) {
    Object.assign(this, { directory, agent, worldId, now });
    this.path = join(directory, 'memory.json');
    this.backup = join(directory, 'memory.backup.json');
    this.lock = join(directory, 'memory.lock');
    this.records = [];
    this.queue = Promise.resolve();
    this.closed = false;
    this.recovered = false;
    this.closing = null;
  }
  async atomicWrite(path, records) {
    const temporary = join(this.lock, 'pending.json');
    const file = await open(temporary, 'w', 0o600);
    try {
      await file.writeFile(JSON.stringify({ schemaVersion: SCHEMA, agent: this.agent, records }));
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
  }
  remember(kind, observation, result) {
    if (this.closed) return Promise.reject(new MemoryError('memory_closed'));
    const record = {
      id: randomUUID(), at: this.now(), worldId: this.worldId,
      dimension: observation.dimension ?? null,
      position: observation.position ? { x: observation.position.x, y: observation.position.y, z: observation.position.z } : null,
      kind, source: kind === 'goal_result' ? 'local_execution' : 'local_observation',
      data: kind === 'goal_result' ? { tool: result?.tool, state: result?.state } : { health: observation.health ?? null, food: observation.food ?? null }
    };
    if (!validRecord(record)) return Promise.reject(new MemoryError('memory_record_invalid'));
    const operation = this.queue.then(async () => {
      const next = [...this.records, record].slice(-LIMIT);
      // Backup is the last validated in-memory snapshot, never untrusted disk data.
      await this.atomicWrite(this.backup, this.records);
      await this.atomicWrite(this.path, next);
      this.records = next;
      return structuredClone(record);
    });
    this.queue = operation.catch(() => {}); // One I/O error does not poison later writes.
    return operation.catch(() => { throw new MemoryError('memory_write_failed'); });
  }
  retrieve({ dimension, position = null, limit = 8 } = {}) {
    if (!label(dimension) || !coordinate(position) || !Number.isInteger(limit) || limit < 1 || limit > 20) return [];
    const now = this.now();
    const score = record => {
      const ageDays = Math.max(0, now - record.at) / 86400000;
      const proximity = position && record.position ? 20 / (1 + Math.hypot(position.x - record.position.x, position.y - record.position.y, position.z - record.position.z) / 32) : 0;
      const importance = record.kind === 'death' ? 30 : record.kind === 'goal_result' && record.data.state !== 'COMPLETED' ? 15 : 0;
      return importance + proximity + 10 / (1 + ageDays);
    };
    return this.records.filter(r => r.worldId === this.worldId && r.dimension === dimension).sort((a, b) => score(b) - score(a) || b.at - a.at).slice(0, limit).map(r => structuredClone(r));
  }
  get size() { return this.records.length; }
  async flush() { await this.queue; }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.queue.then(() => rm(this.lock, { recursive: true, force: true }));
    return this.closing;
  }
}
