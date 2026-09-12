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
  return { aiEnabled: env.AI_ENABLED === 'true', aiIntervalMs, dailyRequestLimit, host: env.MC_HOST.trim(), port, version: env.MC_VERSION || '1.21.1', auth: env.MC_AUTH, username: env.MC_USERNAME?.trim() || null, agent };
}
