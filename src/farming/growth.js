import { readBlock } from '../../shared/tools/resources.js';
import { cropAge } from '../../shared/tools/farm.js';
import { waterSource } from '../../shared/tools/farm-development.js';
export function hydration(bot, p) {
  let known = true;
  for (let dx = -4; dx <= 4; dx++) for (let dy = 0; dy <= 1; dy++) for (let dz = -4; dz <= 4; dz++) {
    const block = readBlock(bot, { x: p.x + dx, y: p.y - 1 + dy, z: p.z + dz });
    if (!block) known = false;
    // Flowing water also hydrates soil; source status is needed for extraction,
    // not for water's existing hydration coverage.
    if (block?.name === 'water') return { state: 'covered', source: waterSource(block), position: { x: block.position.x, y: block.position.y, z: block.position.z } };
  }
  return { state: known ? 'uncovered' : 'unknown' };
}
export function growingConditions(bot, p) {
  const block = readBlock(bot, p), soil = readBlock(bot, { ...p, y: p.y - 1 }), above = readBlock(bot, { ...p, y: p.y + 1 });
  const moisture = soil?.getProperties?.().moisture;
  const blockLight = Number.isInteger(above?.light) && above.light >= 0 && above.light <= 15 ? above.light : null;
  const skyLight = Number.isInteger(above?.skyLight) && above.skyLight >= 0 && above.skyLight <= 15 ? above.skyLight : null;
  const light = blockLight >= 9 ? 'lit' : blockLight === null ? 'unknown' : skyLight === 0 || skyLight !== null && skyLight < 9 ? 'dark' : 'sunlight_variable';
  return { position: { x: p.x, y: p.y, z: p.z }, crop: block?.name || null, age: cropAge(block), moisture: /^[0-7]$/.test(String(moisture)) ? Number(moisture) : null, light, blockLight, skyLight, hydration: hydration(bot, p).state, growthGuaranteed: false };
}
// Only continuously nearby, loaded observations count towards a suspected stall.
// Offline time, stale chunks, clock regression or a changed plant reset the timer.
export class GrowthMonitor {
  constructor({ now = Date.now, stallMs = 20 * 60000 } = {}) { this.now = now; this.stallMs = stallMs; this.records = new Map(); this.scope = null; }
  observe(bot, farm, cells) {
    const scope = JSON.stringify([bot.game?.dimension, farm]);
    if (scope !== this.scope) { this.scope = scope; this.records.clear(); }
    const now = this.now(), result = [], seen = new Set();
    for (const cell of cells.slice(0, 25)) {
      const value = growingConditions(bot, cell), key = `${cell.x},${cell.y},${cell.z}`;
      if (value.age === null || value.crop !== farm.crop || !bot.entity?.position || bot.entity.position.distanceTo({ x: cell.x, y: cell.y, z: cell.z }) > 8) continue;
      seen.add(key);
      let prior = this.records.get(key);
      if (!prior || now < prior.seen || now - prior.seen > 60000 || prior.age !== value.age) prior = { age: value.age, since: now, nextRecovery: 0 };
      prior.seen = now; this.records.set(key, prior);
      result.push({ ...value, unchangedObservedMs: now - prior.since, suspectedStall: now - prior.since >= this.stallMs, recoveryAllowed: now >= prior.nextRecovery });
    }
    for (const key of this.records.keys()) if (!seen.has(key)) this.records.delete(key);
    return result;
  }
  attempted(p) { const record = this.records.get(`${p.x},${p.y},${p.z}`); if (record) record.nextRecovery = this.now() + 10 * 60000; }
}
