export function parseConfig(env, agent) {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agent)) throw new Error('Invalid agent identifier');
  if (!env.MC_HOST?.trim()) throw new Error('MC_HOST is required');
  const port = Number(env.MC_PORT || 25565);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MC_PORT');
  if (!['offline', 'microsoft'].includes(env.MC_AUTH)) throw new Error('Set MC_AUTH explicitly to offline or microsoft');
  if (env.MC_AUTH === 'microsoft' && !env.MC_USERNAME?.trim()) throw new Error('MC_USERNAME is required for Microsoft authentication');
  return { host: env.MC_HOST.trim(), port, version: env.MC_VERSION || '1.21.1', auth: env.MC_AUTH, username: env.MC_USERNAME?.trim() || null, agent };
}
