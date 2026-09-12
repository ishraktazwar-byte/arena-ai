import { validObjective, assessObjective } from '../strategy/objectives.js';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RESOURCE_LIMIT, resourcePosition, resourceBlock, resourceSightings, mergeResourceRecords, recallResources } from './resources.js';

const SCHEMA = 10; // v1-v9 remain readable; planting outcomes require v10 on write.
const LIMIT = 500;
const MAX_BYTES = 2 * 1024 * 1024;
const KINDS = new Set(['spawn', 'death', 'observation', 'goal_result', 'resource_sighting', 'objective']);
const STATES = new Set(['COMPLETED', 'BLOCKED', 'CANCELLED', 'FAILED']);
const TOOLS = new Set(['scan', 'wait', 'move_step', 'scan_resources', 'mine', 'craft_options', 'craft', 'workspace_options', 'place_crafting_table', 'craft_at_table', 'scan_items', 'collect_items', 'navigate_local', 'scan_crops', 'harvest_crop', 'plant_crop']); // Historical names remain readable even if a tool is disabled.
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
  if (record.kind === 'objective') return record.source === 'cloud_intent' && label(record.dimension) && keysAre(record.data, ['objective']) && validObjective(record.data.objective);
  if (record.kind === 'resource_sighting') return record.source === 'local_observation' && label(record.dimension) && resourcePosition(record.position) && keysAre(record.data, ['block']) && resourceBlock(record.data.block);
  if (record.kind === 'goal_result') return record.source === 'local_execution' && keysAre(record.data, ['tool', 'state']) && TOOLS.has(record.data.tool) && STATES.has(record.data.state);
  return record.source === 'local_observation' && keysAre(record.data, ['health', 'food']) && ['health', 'food'].every(key => record.data[key] === null || (Number.isFinite(record.data[key]) && record.data[key] >= 0 && record.data[key] <= 20));
}

async function load(path, agent) {
  if ((await stat(path)).size > MAX_BYTES) throw new MemoryError('memory_corrupt');
  const raw = await readFile(path, 'utf8');
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new MemoryError('memory_corrupt');
  let envelope;
  try { envelope = JSON.parse(raw); } catch { throw new MemoryError('memory_corrupt'); }
  if (Number.isInteger(envelope?.schemaVersion) && ![1, 2, 3, 4, 5, 6, 7, 8, 9, SCHEMA].includes(envelope.schemaVersion)) throw new MemoryError('memory_schema_unsupported');
  if (!keysAre(envelope, ['schemaVersion', 'agent', 'records']) || ![1, 2, 3, 4, 5, 6, 7, 8, 9, SCHEMA].includes(envelope.schemaVersion) || envelope.agent !== agent || !Array.isArray(envelope.records) || envelope.records.length > LIMIT || !envelope.records.every(validRecord)) throw new MemoryError('memory_corrupt');
  if (new Set(envelope.records.map(r => r.id)).size !== envelope.records.length) throw new MemoryError('memory_corrupt');
  const resources = envelope.records.filter(record => record.kind === 'resource_sighting');
  const locations = resources.map(record => JSON.stringify([record.worldId, record.dimension, record.position.x, record.position.y, record.position.z]));
  if (resources.length > RESOURCE_LIMIT || new Set(locations).size !== resources.length || (envelope.schemaVersion < 6 && resources.length)) throw new MemoryError('memory_corrupt');
  const objectives = envelope.records.filter(record => record.kind === 'objective');
  if (objectives.length > 8 || new Set(objectives.map(record => JSON.stringify([record.worldId, record.dimension]))).size !== objectives.length || (envelope.schemaVersion < 8 && objectives.length)) throw new MemoryError('memory_corrupt');
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
    // Sightings are generated only from local observation/spawn input, never
    // from a model-supplied goal result or arbitrary direct resource writes.
    if (!['spawn', 'death', 'observation', 'goal_result', 'objective'].includes(kind)) return Promise.reject(new MemoryError('memory_record_invalid'));
    const record = {
      id: randomUUID(), at: this.now(), worldId: this.worldId,
      dimension: observation.dimension ?? null,
      position: observation.position ? { x: observation.position.x, y: observation.position.y, z: observation.position.z } : null,
      kind, source: kind === 'objective' ? 'cloud_intent' : kind === 'goal_result' ? 'local_execution' : 'local_observation',
      data: kind === 'objective' ? { objective: structuredClone(result?.objective) } : kind === 'goal_result' ? { tool: result?.tool, state: result?.state } : { health: observation.health ?? null, food: observation.food ?? null }
    };
    if (!validRecord(record)) return Promise.reject(new MemoryError('memory_record_invalid'));
    const sightings = ['spawn', 'observation'].includes(kind) && label(record.dimension) ? resourceSightings(observation).map(item => ({
      id: randomUUID(), at: record.at, worldId: this.worldId, dimension: record.dimension,
      position: item.position, kind: 'resource_sighting', source: 'local_observation', data: { block: item.block }
    })) : [];
    const operation = this.queue.then(async () => {
      let records = this.records;
      if (kind === 'objective') {
        const matches = prior => prior.kind === 'objective' && prior.worldId === record.worldId && prior.dimension === record.dimension;
        if (records.some(prior => matches(prior) && prior.at > record.at)) throw new MemoryError('memory_objective_clock_regression');
        records = records.filter(prior => !matches(prior));
      }
      const merged = mergeResourceRecords([...records, record], sightings);
      const objectives = merged.filter(entry => entry.kind === 'objective').slice(-8);
      const next = [...merged.filter(entry => entry.kind !== 'objective').slice(-(LIMIT - objectives.length)), ...objectives];
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
    return this.records.filter(r => r.kind !== 'resource_sighting' && r.kind !== 'objective' && r.worldId === this.worldId && r.dimension === dimension).sort((a, b) => score(b) - score(a) || b.at - a.at).slice(0, limit).map(r => structuredClone(r));
  }
  retrieveResources(observation = {}, { limit = 8 } = {}) {
    const { dimension, position = null } = observation;
    if (!label(dimension) || !coordinate(position) || !Number.isInteger(limit) || limit < 1 || limit > 16) return [];
    return recallResources(this.records, { worldId: this.worldId, dimension, position, now: this.now(), limit, current: observation });
  }
  retrieveObjective(observation = {}) {
    if (!label(observation.dimension)) return null;
    const record = this.records.find(entry => entry.kind === 'objective' && entry.worldId === this.worldId && entry.dimension === observation.dimension);
    return assessObjective(record, observation, this.now());
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
