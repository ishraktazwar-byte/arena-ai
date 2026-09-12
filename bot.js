import 'dotenv/config';
import mineflayer from 'mineflayer';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseConfig } from './src/config.js';
import { attachRuntime } from './src/runtime.js';

try {
  const config = parseConfig(process.env, process.argv[2] || 'alice');
  const identity = JSON.parse(readFileSync(new URL(`./agents/${config.agent}.json`, import.meta.url), 'utf8'));
  const emit = event => console.log(JSON.stringify({ at: new Date().toISOString(), agent: config.agent, ...event }));
  const bot = mineflayer.createBot({ host: config.host, port: config.port, version: config.version, auth: config.auth, username: config.username || identity.name, profilesFolder: `runtime/auth/${config.agent}` });
  const runtime = attachRuntime(bot, emit);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let closing = false;
  function close() { if (closing) return; closing = true; terminal.close(); runtime.close(); }
  terminal.on('line', async line => {
    switch (line.trim()) {
      case 'status': emit({ type: 'STATUS', ...runtime.status() }); break;
      case 'step': emit({ type: 'STEP_RESULT', ...await runtime.step() }); break;
      case 'stop': runtime.arbiter.cancel('operator'); break;
      case 'quit': close(); break;
      default: emit({ type: 'HELP', commands: ['status', 'step', 'stop', 'quit'] });
    }
  });
  bot.on('end', () => terminal.close());
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  emit({ type: 'START', version: '0.1.3', message: 'Commands: status, step, stop, quit. Basic eating, bounded ground escape and melee; live validation pending.' });
} catch (error) {
  console.error(`Startup failed: ${error.code === 'ENOENT' ? 'Agent configuration not found' : error.message}`);
  process.exitCode = 1;
}
