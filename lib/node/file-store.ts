// A disk-backed {@link Store} — durable genServer() state, jobs, or raftStore persistence WITHOUT a
// database. Lives OUTSIDE the universal barrel (like hub.ts): it stands on `node:fs`, so the barrel
// stays browser-safe. `node:` specifiers work on Node and on Deno's node-compat, so this one file
// runs on both. One JSON file per key (URL-encoded to a safe filename); writes go through a temp
// file + atomic rename, so a crash mid-write can never corrupt the live file. Assumes ONE writer
// per `dir` (a node's own persistence dir) — it sweeps stale temps on startup.
//
// CAVEAT — durability, not scale: this makes a Store SURVIVE process death, but anything that loads
// its whole state into RAM still does. A raftStore snapshots its ENTIRE state and replays it into
// memory on restart; fileStore persistence makes that durable, not larger-than-RAM. For job volumes
// that outgrow memory, use Postgres (jobs on disk, queried with LIMIT), not a file-backed raftStore.
import { mkdir, readFile, writeFile, rename, unlink, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from './store.ts';

/**
 * A {@link Store} persisted to JSON files under `dir` — for durable `genServer()` state, single-host
 * jobs, or `raftStore` persistence, none of which need an external database. Only load/save/clear
 * (the durability seam); the atomic `claim`/`lease` belong to distributed backends (Postgres,
 * raftStore), not a single host.
 *
 * A plain save is atomic (temp file + rename) and survives a **process** crash — the OS page cache
 * outlives the process. `{ fsync: true }` additionally flushes each write to the platter before it
 * becomes the live file, so it survives a **power loss / kernel panic** too — the durability Raft's
 * safety leans on, at the cost of a disk flush per write. Default off (the fast path).
 *
 * ```ts
 * const store = fileStore('/var/lib/qunitx', { fsync: true }); // power-loss durable; no I/O until first use
 * typeof store.save; // 'function'
 * ```
 */
export function fileStore(dir: string, options: { fsync?: boolean } = {}): Store {
  const fsync = options.fsync ?? false;
  let ready: Promise<unknown> | undefined;

  const init = async (): Promise<void> => {
    await mkdir(dir, { recursive: true });
    // Sweep orphan temp files a crash may have left mid-save (single-writer dir assumed).
    try {
      const stale = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
      await Promise.all(stale.map((name) => unlink(join(dir, name)).catch(() => {})));
    } catch {
      // listing failed — non-fatal; the sweep is best-effort housekeeping
    }
  };
  const ensure = (): Promise<unknown> => {
    ready ??= init().catch((error) => {
      ready = undefined; // a transient failure (e.g. a permission that gets fixed) retries next op
      throw error;
    });
    return ready;
  };
  const pathFor = (key: string): string => join(dir, `${encodeURIComponent(key)}.json`);

  // Flush the directory entry itself so the rename is durable. Not portable (Windows can't fsync a
  // dir) — best-effort; the file's own fsync is the load-bearing guarantee.
  const syncDir = async (): Promise<void> => {
    try {
      const handle = await open(dir, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // directory fsync unsupported here — skip
    }
  };

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
      const json = JSON.stringify(state);
      if (fsync) {
        const handle = await open(tmp, 'w');
        try {
          await handle.writeFile(json);
          await handle.sync(); // flush the bytes to disk BEFORE the temp becomes the live file
        } finally {
          await handle.close();
        }
        await rename(tmp, target); // atomic swap
        await syncDir(); // and make the swap itself durable
      } else {
        await writeFile(tmp, json);
        await rename(tmp, target); // atomic swap — survives a process crash, not a power loss
      }
    },
    async clear(key) {
      await ensure();
      try {
        await unlink(pathFor(key));
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error; // already gone is fine
      }
    },
    async keys(prefix) {
      await ensure();
      // Each key is stored as `encodeURIComponent(key).json`; recover the keys and filter by prefix.
      return (await readdir(dir))
        .filter((name) => name.endsWith('.json'))
        .map((name) => decodeURIComponent(name.slice(0, -'.json'.length)))
        .filter((key) => key.startsWith(prefix));
    },
  };
}
