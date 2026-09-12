import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

// A shared filesystem reservation prevents nine processes multiplying a daily
// account budget. A crashed lock fails closed rather than permitting overspend.
export class SharedBudget {
  constructor(directory, limit = 24, now = Date.now) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('Invalid daily budget');
    Object.assign(this, { directory, limit, now });
  }
  async reserve() {
    await mkdir(this.directory, { recursive: true });
    const lock = join(this.directory, 'request-budget.lock');
    try { await mkdir(lock); } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    try {
      const date = new Date(this.now()).toISOString().slice(0, 10);
      const path = join(this.directory, 'request-budget.json');
      let stored;
      try { stored = JSON.parse(await readFile(path, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') return false; }
      if (stored && (typeof stored.date !== 'string' || !Number.isInteger(stored.count) || stored.count < 0)) return false;
      // Backwards wall-clock changes must not reset a consumed budget.
      if (stored && stored.date > date) return false;
      const count = stored?.date === date ? stored.count : 0;
      if (count >= this.limit) return false;
      const temporary = join(lock, 'next.json');
      await writeFile(temporary, JSON.stringify({ date, count: count + 1 }), { mode: 0o600 });
      await rename(temporary, path);
      return true;
    } finally { await rm(lock, { recursive: true }); }
  }
}
