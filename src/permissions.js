const DIMENSIONS = Object.freeze(['overworld', 'the_nether', 'the_end']);
const validPosition = p => !!p && ['x', 'y', 'z'].every(key => Number.isFinite(p[key]) && Math.abs(p[key]) <= 30000000) && p.y >= -64 && p.y < 320;

// Trusted deployment policy, not model output. World scope authorizes the
// existing skills across vanilla dimensions without manually drawn rectangles.
export function autonomousWorldPolicy() {
  return { enabled: true, scope: 'world', dimensions: [...DIMENSIONS] };
}
export function permitsPosition(policy, dimension, p) {
  if (policy?.enabled !== true || !validPosition(p) || !DIMENSIONS.includes(dimension)) return false;
  if (policy.scope === 'world') return Array.isArray(policy.dimensions) && policy.dimensions.includes(dimension);
  if (policy.scope !== undefined && policy.scope !== 'area') return false;
  const a = policy.area;
  if (!a || !['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'].every(key => Number.isSafeInteger(a[key]) && Math.abs(a[key]) <= 30000000) || a.minX > a.maxX || a.minY > a.maxY || a.minZ > a.maxZ || a.minY < -64 || a.maxY > 319) return false;
  return !!( dimension === policy.dimension && p.x >= a.minX && p.x < a.maxX + 1 && p.y >= a.minY && p.y < a.maxY + 1 && p.z >= a.minZ && p.z < a.maxZ + 1);
}
export function permitsBlock(policy, dimension, p) {
  return !!p && ['x', 'y', 'z'].every(key => Number.isInteger(p[key])) && permitsPosition(policy, dimension, p);
}
export function permissionConstraints(policy) {
  return policy.scope === 'world'
    ? { scope: 'world', dimensions: [...policy.dimensions] }
    : { scope: 'area', dimension: policy.dimension, area: structuredClone(policy.area) };
}
