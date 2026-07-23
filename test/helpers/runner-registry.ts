import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import * as Result from '../../lib/result/index.ts';
import { ignore } from '../../lib/result/failure.ts';

/**
 * Lets several test runners share one checkout.
 *
 * test/runner.ts wipes tmp/ at startup, and tmp/ holds everything the suite depends on:
 * fixtures, per-run `--output` dirs, perf/junit artifacts. A second runner therefore used to
 * delete the first's world mid-run — and the damage landed on the *innocent* run, as scattered
 * ENOENT failures on files that existed moments earlier, while the culprit exited 0.
 *
 * Everything else about concurrent runners is already safe: fixtures and `--output` dirs are
 * uuid-scoped, `--only-failed` tests give each project its own cwd (so their failure caches are
 * isolated), and the semaphore port travels by env rather than a shared file. The wipe was the
 * whole problem, so only the wipe is coordinated:
 *
 *   acquire mutex          (held for the wipe, not the run — nobody waits on anyone's tests)
 *     no other live runner → wipe tmp/       (the solo case: identical to before)
 *     otherwise            → skip the wipe   (nobody's world gets deleted)
 *     register self
 *   release mutex
 *
 * The mutex is what makes "am I alone?" and the wipe atomic: without it a runner could decide
 * it was alone and start wiping at the exact moment another began creating files. Latecomers
 * block only until the wipe finishes.
 *
 * Trade-off: while two runners are live nobody wipes, so tmp/ accrues garbage until the next
 * solo run cleans it. tmp/ is gitignored and the wipe is hygiene, so this self-heals.
 *
 * Liveness is by pid, never by age: `npm run dev` holds a registration for as long as watch
 * mode runs, so any age cutoff would eventually ignore a healthy runner. A crash leaves a dead
 * entry that the next join reaps.
 */

const CACHE_DIR = path.resolve('node_modules/.cache/qunitx');
const DEFAULT_REGISTRY_DIR = path.join(CACHE_DIR, 'runners');

/** How long to wait for the wipe mutex before giving up and skipping the wipe. */
const MUTEX_WAIT_MS = 60_000;
const MUTEX_POLL_MS = 20;

/** A live runner's registry entry. */
export interface RunnerEntry {
  /** OS pid; liveness of this pid is what makes the entry count. */
  pid: number;
  /** Epoch ms the runner joined. Diagnostics only — never used to judge liveness. */
  startedAt: number;
}

/** Handle for this runner's membership in the registry. */
export interface RunnerHandle {
  /** Unique per live runner; scopes artifact filenames so concurrent runs don't clobber. */
  runId: string;
  /** True when this runner was alone at startup and therefore wiped tmp/. */
  wasSolo: boolean;
  /** Removes this runner's entry. */
  release: () => Promise<void>;
}

/**
 * Joins the registry, running `onSolo` (the tmp/ wipe) only if no other runner is live — and
 * only while the mutex is held, so no one else can be mid-startup when it happens. `onSolo` may
 * be sync or async; it is awaited either way.
 */
export async function joinRunnerRegistry(
  onSolo: () => void | Promise<void>,
  registryDir: string = DEFAULT_REGISTRY_DIR,
): Promise<RunnerHandle> {
  await fs.mkdir(registryDir, { recursive: true });
  const entryPath = path.join(registryDir, String(process.pid));
  const mutexPath = `${registryDir}.lock`;

  const releaseMutex = await acquireMutex(mutexPath);
  let wasSolo = false;
  try {
    wasSolo = (await liveRunners(registryDir)).length === 0;
    // Skipping the wipe is always safe; wiping while someone else runs is the bug. So when the
    // mutex could not be taken (releaseMutex === null) we simply don't wipe.
    if (wasSolo && releaseMutex) await onSolo();
    await fs.writeFile(entryPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  } finally {
    await releaseMutex?.();
  }

  return {
    runId: String(process.pid),
    wasSolo,
    release: () => fs.unlink(entryPath).catch(ignore('runner registry entry release')),
  };
}

/**
 * Live runners other than us, reaping entries whose pid is gone. A crashed runner must not make
 * every later run think it has company and skip the wipe forever.
 */
export async function liveRunners(
  registryDir: string = DEFAULT_REGISTRY_DIR,
): Promise<RunnerEntry[]> {
  const names = await fs
    .readdir(registryDir)
    .catch((error) => (ignore('runner registry listing')(error), [] as string[]));
  const live: RunnerEntry[] = [];
  for (const name of names) {
    const entryPath = path.join(registryDir, name);
    const entry = await readEntry(entryPath);
    if (!entry || entry.pid === process.pid) continue;
    if (isAlive(entry.pid)) live.push(entry);
    else await fs.unlink(entryPath).catch(ignore('stale runner registry entry unlink'));
  }
  return live;
}

/**
 * Takes the wipe mutex, waiting rather than refusing: it is held only for the wipe, so the wait
 * is bounded by that. Returns null if it could not be taken in time — the caller then skips the
 * wipe rather than doing it unprotected. A dead holder's mutex is reclaimed immediately.
 */
async function acquireMutex(mutexPath: string): Promise<(() => Promise<void>) | null> {
  const deadline = Date.now() + MUTEX_WAIT_MS;
  for (;;) {
    if (await publish(mutexPath, { pid: process.pid, startedAt: Date.now() })) {
      return () => releaseIfOwner(mutexPath);
    }
    const holder = await readEntry(mutexPath);
    if (!holder || !isAlive(holder.pid)) {
      await fs.unlink(mutexPath).catch(ignore('runner registry mutex unlink'));
      continue;
    }
    if (Date.now() >= deadline) return null;
    await sleep(MUTEX_POLL_MS);
  }
}

/**
 * Publishes atomically: write a temp file, then hardlink it into place. `link` either succeeds
 * or fails EEXIST, and the content is already on disk when the name appears — unlike
 * `writeFile(…, { flag: 'wx' })`, where the create is atomic but the write lands microseconds
 * later, so a contender can read an empty file, parse pid as NaN, call it stale, and steal a
 * *live* lock. (Same reasoning as `tryAcquireDaemonLock` in lib/commands/daemon/server.ts.)
 */
async function publish(lockPath: string, entry: RunnerEntry): Promise<boolean> {
  const tmpPath = `${lockPath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(entry));
  try {
    // EEXIST is the whole point of the link: someone else published first, which is an
    // outcome, not a fault. Declaring it means an EACCES or ENOSPC on the registry directory
    // propagates instead of being read as "we lost the race" and silently disabling the cap.
    const linked = await Result.try(() => fs.link(tmpPath, lockPath), {
      catch: Result.errno('EEXIST'),
    });
    return linked.ok;
  } finally {
    // Drop our second reference; on success the lock's own name keeps the inode alive.
    await fs.unlink(tmpPath).catch(ignore('runner registry tmpfile unlink'));
  }
}

// `null` here means "no usable entry", which is genuinely all three of missing, torn, and
// written by an incompatible version — the caller treats them identically, so a Result would
// name distinctions nobody acts on. The boundary still declares what it expects: a read error
// or a parse error, not a bug in the shape check below.
async function readEntry(entryPath: string): Promise<RunnerEntry | null> {
  const read = await Result.try(() => fs.readFile(entryPath, 'utf8'), {
    catch: Result.errno(),
  });
  if (!read.ok) return null;
  const parsed = Result.try(() => JSON.parse(read.value) as Partial<RunnerEntry>, {
    catch: SyntaxError,
  });
  if (!parsed.ok) return null;
  return typeof parsed.value.pid === 'number' && typeof parsed.value.startedAt === 'number'
    ? (parsed.value as RunnerEntry)
    : null;
}

// EPERM means the pid exists under another user — alive, just not ours to signal. ESRCH is
// the real "no such process". Anything else (an invalid pid, a bad signal) is a bug and is
// left to propagate rather than being reported as "not alive".
function isAlive(pid: number): boolean {
  const signalled = Result.try(() => process.kill(pid, 0), {
    catch: Result.errno('EPERM', 'ESRCH'),
  });
  return signalled.ok || signalled.error.code === 'EPERM';
}

// Only ever remove our own lock: a late release must not clear one someone else now holds.
async function releaseIfOwner(lockPath: string): Promise<void> {
  if ((await readEntry(lockPath))?.pid !== process.pid) return;
  await fs.unlink(lockPath).catch(ignore('runner registry lock unlink'));
}
