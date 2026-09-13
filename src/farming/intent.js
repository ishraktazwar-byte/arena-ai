export const FARM_CROPS = Object.freeze({ wheat: { seed: 'wheat_seeds', produce: 'wheat', age: 7 }, carrots: { seed: 'carrot', produce: 'carrot', age: 7 }, potatoes: { seed: 'potato', produce: 'potato', age: 7 }, beetroots: { seed: 'beetroot_seeds', produce: 'beetroot', age: 3 } });
export function validFarm(value) {
  return value === null || (!!value && !Array.isArray(value) && Object.keys(value).sort().join(',') === 'crop,reserve,targetStock,x,y,z' && Object.hasOwn(FARM_CROPS, value.crop) && ['x', 'y', 'z'].every(k => Number.isInteger(value[k]) && Math.abs(value[k]) <= 29999997) && value.y >= -63 && value.y <= 319 && ['reserve', 'targetStock'].every(k => Number.isInteger(value[k]) && value[k] >= 1 && value[k] <= 64));
}
export function insideFarm(farm, p) { return !!farm && !!p && Math.abs(p.x - farm.x) <= 2 && Math.abs(p.z - farm.z) <= 2 && p.y === farm.y; }
