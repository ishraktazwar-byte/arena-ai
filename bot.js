import 'dotenv/config';
import mineflayer from 'mineflayer';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseConfig } from './src/config.js';
import { attachRuntime } from './src/runtime.js';
import { SharedBudget } from './src/strategy/budget.js';
import { OpenRouterProvider } from './src/strategy/provider.js';
import { MemoryStore } from './src/memory/store.js';

let memory, bot, runtime, terminal;
let finalizing;
async function finalize() {
  if (finalizing) return finalizing;
  finalizing = (async () => {
    terminal?.close();
    await runtime?.settle();
    await memory?.close();
  })();
  return finalizing;
}
try {
  const config = parseConfig(process.env, process.argv[2] || 'alice');
  const identity = JSON.parse(readFileSync(new URL(`./agents/${config.agent}.json`, import.meta.url), 'utf8'));
  const emit = event => console.log(JSON.stringify({ at: new Date().toISOString(), agent: config.agent, ...event }));
  // Acquire memory ownership before joining: duplicate processes fail early.
  memory = await MemoryStore.open({ directory: `runtime/agents/${config.agent}`, agent: config.agent, worldId: config.worldId });
  emit({ type: 'MEMORY-READY', records: memory.size, recovered: memory.recovered });
  emit({ type: 'OPERATING-POLICY', mode: config.operatingMode, restrictedSettingsIgnored: config.restrictedSettingsIgnored, cloudPlanningEnabled: config.aiEnabled });
  bot = mineflayer.createBot({ host: config.host, port: config.port, version: config.version, auth: config.auth, username: config.username || identity.name, profilesFolder: `runtime/auth/${config.agent}` });
  const budget = new SharedBudget('runtime/shared', config.dailyRequestLimit);
  const provider = config.aiEnabled ? new OpenRouterProvider({ apiKey: process.env.OPENROUTER_API_KEY, reserve: () => budget.reserve() }) : null;
  runtime = attachRuntime(bot, emit, { provider, identity, aiIntervalMs: config.aiIntervalMs, memory, miningPolicy: config.miningPolicy, workspacePolicy: config.workspacePolicy, collectionPolicy: config.collectionPolicy, navigationPolicy: config.navigationPolicy, farmingPolicy: config.farmingPolicy, operatingMode: config.operatingMode });
  terminal = createInterface({ input: process.stdin, output: process.stdout });
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    try { await runtime.close(); await finalize(); }
    catch { emit({ type: 'SHUTDOWN-ERROR', code: 'cleanup_failed' }); process.exitCode = 1; }
  }
  terminal.on('line', async line => {
    try {
      switch (line.trim()) {
        case 'status': emit({ type: 'STATUS', ...runtime.status() }); break;
        case 'step': emit({ type: 'STEP_RESULT', ...await runtime.step() }); break;
        case 'stop': runtime.arbiter.cancel('operator'); break;
        case 'quit': await close(); break;
        default: emit({ type: 'HELP', commands: ['status', 'step', 'stop', 'quit'] });
      }
    } catch { emit({ type: 'COMMAND-ERROR', code: 'command_failed' }); }
  });
  bot.on('end', () => { void finalize().catch(() => { emit({ type: 'MEMORY-ERROR', code: 'memory_close_failed' }); process.exitCode = 1; }); });
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  emit({ type: 'START', version: '0.2.14', message: 'Commands: status, step, stop, quit. Persistent local memory enabled; cloud planning opt-in. Live validation pending.' });
} catch (error) {
  console.error(`Startup failed: ${error.code === 'ENOENT' ? 'Agent configuration not found' : error.code?.startsWith('memory_') ? error.code : 'Check local configuration and dependencies'}`);
  bot?.quit();
  await finalize().catch(() => {});
  process.exitCode = 1;
}
