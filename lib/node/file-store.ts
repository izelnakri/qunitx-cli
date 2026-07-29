// A disk-backed {@link Store} — durable serve() state, jobs, or raftStore persistence WITHOUT a
// database. Lives OUTSIDE the universal barrel (like hub.ts): it stands on `node:fs`, so the barrel
// stays browser-safe. `node:` specifiers work on Node and on Deno's node-compat, so this one file
// runs on both. One JSON file per key (URL-encoded to a safe filename); writes go through a temp
// file + atomic rename, so a crash mid-write can never corrupt the live file.
//
// CAVEAT — durability, not scale: this makes a Store SURVIVE process death, but anything that loads
// its whole state into RAM still does. A raftStore snapshots its ENTIRE state and replays it into
// memory on restart; fileStore persistence makes that durable, not larger-than-RAM. For job volumes
// that outgrow memory, use Postgres (jobs on disk, queried with LIMIT), not a file-backed raftStore.
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from './upgradable.ts';

/**
 * A {@link Store} persisted to JSON files under `dir` — for durable `serve()` state, single-host
 * jobs, or `raftStore` persistence, none of which need an external database. Only load/save/clear
 * (the durability seam); the atomic `claim`/`lease` belong to distributed backends (Postgres,
 * raftStore), not a single host.
 *
 * ```ts
 * const store = fileStore('/var/lib/qunitx'); // no I/O until first use — mkdir is lazy
 * typeof store.save; // 'function'
 * ```
 */
export function fileStore(dir: string): Store {
  let ready: Promise<unknown> | undefined;
  const ensure = (): Promise<unknown> => (ready ??= mkdir(dir, { recursive: true }));
  const pathFor = (key: string): string => join(dir, `${encodeURIComponent(key)}.json`);
  return {
    async load(key) {
      await ensure();
      try {
        return JSON.parse(await readFile(pathFor(key), 'utf8'));
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') return undefined; // no file = no value
        throw error;
      }
    },
    async save(key, state) {
      await ensure();
      const target = pathFor(key);
      const tmp = `${target}.${crypto.randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(state));
      await rename(tmp, target); // atomic swap — a crash mid-write leaves the old file intact
    },
    async clear(key) {
      await ensure();
      try {
        await unlink(pathFor(key));
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error; // already gone is fine
      }
    },
  };
}
