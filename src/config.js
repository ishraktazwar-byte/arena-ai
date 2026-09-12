export function parseConfig(env, agent) {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agent)) throw new Error('Invalid agent identifier');
  if (!env.MC_HOST?.trim()) throw new Error('MC_HOST is required');
  const port = Number(env.MC_PORT || 25565);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MC_PORT');
  if (!['offline', 'microsoft'].includes(env.MC_AUTH)) throw new Error('Set MC_AUTH explicitly to offline or microsoft');
  if (env.MC_AUTH === 'microsoft' && !env.MC_USERNAME?.trim()) throw new Error('MC_USERNAME is required for Microsoft authentication');
  if (env.AI_ENABLED && !['true', 'false'].includes(env.AI_ENABLED)) throw new Error('AI_ENABLED must be true or false');
  const aiIntervalMs = Number(env.AGENT_AI_INTERVAL_MS || 300000);
  const dailyRequestLimit = Number(env.AI_DAILY_REQUEST_LIMIT || 24);
  if (!Number.isInteger(aiIntervalMs) || aiIntervalMs < 1000 || aiIntervalMs > 86400000) throw new Error('Invalid AGENT_AI_INTERVAL_MS');
  if (!Number.isInteger(dailyRequestLimit) || dailyRequestLimit < 1 || dailyRequestLimit > 10000) throw new Error('Invalid AI_DAILY_REQUEST_LIMIT');
  const worldId = env.MC_WORLD_ID?.trim() || `${env.MC_HOST.trim().toLowerCase()}:${port}`;
  if (!/^[a-zA-Z0-9_:.-]{1,160}$/.test(worldId)) throw new Error('Invalid MC_WORLD_ID');
  const miningPolicy = parseAreaPolicy(env, 'MC_MINING');
  const workspacePolicy = parseAreaPolicy(env, 'MC_WORKSPACE');
  const collectionPolicy = parseAreaPolicy(env, 'MC_COLLECTION');
  return { miningPolicy, workspacePolicy, collectionPolicy, worldId, aiEnabled: env.AI_ENABLED === 'true', aiIntervalMs, dailyRequestLimit, host: env.MC_HOST.trim(), port, version: env.MC_VERSION || '1.21.1', auth: env.MC_AUTH, username: env.MC_USERNAME?.trim() || null, agent };
}

function parseAreaPolicy(env, prefix) {
  const enabled = env[`${prefix}_ENABLED`];
  if (enabled && !['true', 'false'].includes(enabled)) throw new Error(`${prefix}_ENABLED must be true or false`);
  if (enabled !== 'true') return { enabled: false };
  const bounds = (env[`${prefix}_AREA`] || '').split(',').map(value => value.trim());
  if (bounds.length !== 6 || bounds.some(value => !/^-?\d+$/.test(value))) throw new Error(`${prefix}_AREA requires six integer bounds`);
  const [minX, minY, minZ, maxX, maxY, maxZ] = bounds.map(Number);
  if ([minX, minY, minZ, maxX, maxY, maxZ].some(value => !Number.isSafeInteger(value) || Math.abs(value) > 30000000) || minX > maxX || minY > maxY || minZ > maxZ || minY < -64 || maxY > 319) throw new Error(`Invalid ${prefix}_AREA bounds`);
  const dimension = env[`${prefix}_DIMENSION`] || 'overworld';
  if (!['overworld', 'the_nether', 'the_end'].includes(dimension)) throw new Error(`Invalid ${prefix}_DIMENSION`);
  return { enabled: true, dimension, area: { minX, minY, minZ, maxX, maxY, maxZ } };
}
