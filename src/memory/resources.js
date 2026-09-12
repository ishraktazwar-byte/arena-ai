import { resourceNames } from '../../shared/tools/resources.js';

export const RESOURCE_LIMIT = 128;
export const RESOURCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const resourcePosition = p => !!p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).sort().join(',') === 'x,y,z' && ['x', 'y', 'z'].every(key => Number.isInteger(p[key]) && Math.abs(p[key]) <= 30000000) && p.y >= -64 && p.y <= 319;
export const resourceBlock = name => typeof name === 'string' && resourceNames.has(name);
export const samePosition = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;

// Only the bounded local scanner's visible, allowlisted observations are inputs.
// Do not infer depletion from absence: scans are truncated and chunks can unload.
export function resourceSightings(observation) {
  const p = observation.position;
  if (!p || !['x', 'y', 'z'].every(key => Number.isFinite(p[key]) && Math.abs(p[key]) <= 30000000) || !Array.isArray(observation.nearbyResources)) return [];
  const found = new Map();
  for (const item of observation.nearbyResources.slice(0, 16)) {
    if (!item || !resourceBlock(item.name) || !resourcePosition(item.position) || item.visibility !== 'line_of_sight_sampled') continue;
    const q = item.position;
    // Recompute the scanner's four-block eye-to-center range, ignoring supplied
    // distance claims. This is a shape/provenance check, not a new world raycast.
    if (Math.hypot(q.x + 0.5 - p.x, q.y + 0.5 - (p.y + 1.62), q.z + 0.5 - p.z) > 4) continue;
    found.set(`${q.x},${q.y},${q.z}`, { block: item.name, position: { x: q.x, y: q.y, z: q.z } });
  }
  return [...found.values()];
}

export function mergeResourceRecords(records, sightings) {
  let next = [...records];
  for (const sighting of sightings) {
    const matches = record => record.kind === 'resource_sighting' && record.worldId === sighting.worldId && record.dimension === sighting.dimension && samePosition(record.position, sighting.position);
    const prior = next.find(matches);
    if (prior && prior.at > sighting.at) continue;
    next = next.filter(record => !matches(record));
    next.push({ ...sighting, id: prior?.id ?? sighting.id });
  }
  const retained = new Set(next.filter(record => record.kind === 'resource_sighting').reverse().sort((a, b) => b.at - a.at).slice(0, RESOURCE_LIMIT).map(record => record.id));
  return next.filter(record => record.kind !== 'resource_sighting' || retained.has(record.id));
}

export function recallResources(records, { worldId, dimension, position, now, limit, current }) {
  const sightings = resourceSightings(current);
  return records.filter(record => record.kind === 'resource_sighting' && record.worldId === worldId && record.dimension === dimension && record.at <= now && now - record.at < RESOURCE_MAX_AGE_MS).map(record => {
    const distance = position ? Math.hypot(position.x - (record.position.x + 0.5), position.y - (record.position.y + 0.5), position.z - (record.position.z + 0.5)) : null;
    return {
      block: record.data.block, position: { ...record.position }, lastObservedAt: record.at, ageMs: now - record.at,
      distance, source: 'local_observation',
      verification: sightings.some(item => item.block === record.data.block && samePosition(item.position, record.position)) ? 'matches_current_observation' : 'historical_recheck_required',
      executionRecheckRequired: true
    };
  }).sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity) || a.ageMs - b.ageMs || a.position.x - b.position.x || a.position.y - b.position.y || a.position.z - b.position.z).slice(0, limit);
}
