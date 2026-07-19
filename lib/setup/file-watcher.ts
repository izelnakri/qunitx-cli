import fs from 'node:fs';
import { readdir, readFile, stat, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
// See lib/commands/run.ts: node:timers preserves .unref() across Node and Deno.
import { setInterval, clearInterval, setTimeout, clearTimeout } from 'node:timers';
import { green, magenta, red, yellow } from '../utils/color.ts';
import { defaultProjectConfigValues } from './default-project-config-values.ts';
import type { FSWatcher } from 'node:fs';
import type { Config, FSTree } from '../types.ts';

const CHANGE_DEDUPE_MS = 10;
// Rescan mtime pre-filter grace: only tracked files whose mtime is within this window of the
// last build are hashed for change detection (the hash, not mtime, is authoritative — this
// just caps the hashing cost). Generous because `_lastBuildEndMs` is the moment the last build
// *finished*, and a slow browser run (webkit) can push it seconds past the write; a write that
// landed during that build must still be a candidate. Genuinely stale files fall outside it.
const RESCAN_MTIME_GRACE_MS = 30_000;
const SYMLINK_POLL_INTERVAL_MS = 500;
const OVERLAYFS_RENAME_RETRY_MS = 50;
const RESCAN_INTERVAL_MS = 1_000;
// Rename-event coalescing window. Deno's node:fs.watch compat fires duplicate
// 'rename' events for the same path under recursive watching (e.g. two
// consecutive 'rename subdir' events for a single fs.rename). Coalescing
// duplicates within this window prevents double-classification (e.g. two
// unlinkDir invocations → two "REMOVED:" prints for one rename).
const RENAME_DEDUPE_MS = 100;
// True when this process is the Deno runtime (as opposed to Node). Used to
// enable a periodic directory rescan as a safety net for Deno's node:fs.watch
// gaps: on Linux, Deno's recursive watcher silently drops symlink creation /
// rename events. The same rescan loop already exists for macOS FSEvents drops;
// extending it to Deno keeps the cli's add/remove detection complete in both
// environments without a Deno-only fallback path.
const IS_DENO = typeof (globalThis as { Deno?: unknown }).Deno !== 'undefined';
// Per-file 'change' coalescing window. fs.writeFile is not atomic on Windows
// (ReadDirectoryChangesW fires while bytes are still flushing) and the kernel
// can fire 'change' before the writer has finished — also seen on Linux for
// rapid back-to-back writes. Debouncing each file's 'change' events for this
// window ensures the rebuild fires AFTER the writeFile burst settles, so esbuild
// reads the final content rather than a partial snapshot. See the
// 'rapid back-to-back writes coalesce ...' test in file-watcher-test.ts.
const CHANGE_COALESCE_MS = 75;
// A just-written file can be observed mid-flush: fs.writeFile truncates then writes, and Windows'
// ReadDirectoryChangesW fires 'change' at truncate, so a single read can catch the 0-byte window
// and hash empty content — the rebuild then bundles a truncated file esbuild reports as "0 tests".
// readFileStable re-reads until two reads spaced STABILITY_GAP_MS apart are byte-identical; the gap
// lets the write's bytes land between reads, so writeFile's sub-ms truncate window can't survive
// both. Bounded so a file under continuous rewrite proceeds with the latest content rather than
// looping. The gap is negligible next to the 75ms coalesce window that already precedes it.
const STABILITY_GAP_MS = 10;
const MAX_STABILITY_ATTEMPTS = 10;
// Windows fs.watch (ReadDirectoryChangesW) fires both a `rename` (→ classified as 'add')
// AND one or more spurious `change` events for a single fs.writeFile of a new file. The
// trailing 'change' arrives after the add's filtered-rebuild has completed, so the existing
// `building` gate doesn't catch it — it ends up triggering a redundant FULL rebuild that
// races the filtered one. Suppressing 'change' for files added within this window kills the
// race without affecting genuine post-add edits (rare and >> 1s apart in practice).
const ADD_SUPPRESS_WINDOW_MS = 1_000;

// Dispatch a 'change' build ONLY when the file's CONTENT actually differs from what was last
// built. mtime alone is unreliable: macOS/HFS+ reports 1-second mtime resolution, so a burst
// of rapid writes with different content in the same second is indistinguishable by mtime —
// which let the final write of the burst go untested (a 120s watch hang on macOS/webkit).
// Hashing the content is authoritative: an overlayfs/kernel echo hashes identically and is
// dropped, while a genuine change — even one that lands during a slow (webkit) build — is
// always caught. builtContentHash is shared by the fs.watch change handler and the
// rescan safety-net, so whichever dispatches first records the hash and the other won't re-fire.
/**
 * Reads a file, re-reading until two reads spaced `STABILITY_GAP_MS` apart return byte-identical
 * content — so a file caught mid-write (Windows truncate→flush; see STABILITY_GAP_MS) is hashed
 * only once its bytes have settled. Bounded by MAX_STABILITY_ATTEMPTS; returns the latest content
 * if it never stabilizes. `read` is injectable for tests; production reads from disk. Read errors
 * propagate so the caller's catch can treat a vanished file as a removal.
 */
export async function readFileStable(
  filePath: string,
  read: (p: string) => Promise<Buffer> = (p) => readFile(p),
): Promise<Buffer> {
  let previous = await read(filePath);
  for (let attempt = 0; attempt < MAX_STABILITY_ATTEMPTS; attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, STABILITY_GAP_MS));
    const current = await read(filePath);
    if (current.equals(previous)) return current;
    previous = current;
  }
  return previous;
}

async function dispatchIfContentChanged(
  config: Config,
  extensions: string[],
  filePath: string,
  onEventFunc: (event: string, file: string) => unknown,
  onFinishFunc: ((path: string, event: string) => void) | null | undefined,
): Promise<void> {
  let hash: string;
  try {
    hash = createHash('sha1')
      .update(await readFileStable(filePath))
      .digest('hex');
  } catch {
    return; // file vanished mid-read — the unlink/rename passes handle removal
  }
  const hashes = config.state.watch.builtContentHash;
  if (hash === hashes[filePath]) return;
  hashes[filePath] = hash;
  handleWatchEvent(config, extensions, 'change', filePath, onEventFunc, onFinishFunc);
}

/**
 * Starts `fs.watch` watchers for each lookup path and calls `onEventFunc` on JS/TS file changes,
 * debounced via a per-file timestamp. Also watches each path's parent directory to detect when a
 * watched directory is renamed or deleted (since fs.watch tracks by inode, not path).
 * Uses `config.fsTree` to distinguish `unlink` (tracked file) from `unlinkDir` (directory) on deletion.
 */
export function setupFileWatchers(
  testFileLookupPaths: string[],
  config: Config,
  onEventFunc: (event: string, file: string) => unknown,
  onFinishFunc: ((path: string, event: string) => void) | null | undefined,
): {
  fileWatchers: Record<string, FSWatcher>;
  killFileWatchers: () => Record<string, FSWatcher>;
  ready: Promise<void>;
} {
  const extensions = config.extensions || defaultProjectConfigValues.extensions;
  // Seed the build-end timestamp so the macOS rescan has a baseline for detecting modifies
  // fs.watch may have dropped. The initial build does not flow through handleWatchEvent (it
  // runs directly from run.ts), so on a failed initial build lastBuildEndMs would otherwise
  // stay 0 and the rescan could not distinguish stale files from genuine modifications.
  config.state.watch.lastBuildEndMs ||= Date.now();
  // Seed the content-hash baseline for already-tracked files so the first rescan tick doesn't
  // rebuild every file: an unchanged file hashes identically to its seed and is skipped, while a
  // genuine post-startup modification — even a same-second one mtime can't see — hashes
  // differently and fires. Reads run in parallel (non-blocking), but each watcher's `ready` flag
  // is gated on this promise below, so no change event is processed until seeding completes. That
  // ordering is load-bearing: without it, a seed read that lands after the first user write would
  // capture the already-changed content and then miss that change (it hashes identically to the
  // seed) — which was the hang. Seeding never clobbers a hash a build already recorded.
  const builtContentHash = config.state.watch.builtContentHash;
  const seedPromise = Promise.all(
    Object.keys(config.fsTree).map(async (filePath) => {
      try {
        const buf = await readFile(filePath);
        builtContentHash[filePath] ??= createHash('sha1').update(buf).digest('hex');
      } catch {
        /* unreadable at startup — first real event will be treated as a change */
      }
    }),
  );
  const readyPromises: Promise<void>[] = [];
  const parentWatchers: FSWatcher[] = [];
  const rescanTimers: ReturnType<typeof setInterval>[] = [];
  const fileWatchers: Record<string, FSWatcher> = {};
  // Cancellers for fs.watchFile polls on symlink files.
  // On Linux, fs.unlink on a symlink fires NO fs.watch rename event, so the child watcher
  // never sees the deletion. fs.watchFile (stat-polling) fills that gap: when stat() on the
  // symlink path fails (symlink deleted or target gone/moved), nlink drops to 0 and we
  // synthesize an 'unlink' event. A 500 ms interval balances latency vs CPU cost.
  const symlinkPollers = new Map<string, () => void>();
  // Per-file debounce timers for 'change' events; cleared on killFileWatchers so a
  // pending timer can't fire onEventFunc against a torn-down watcher. Map (vs Record)
  // because we delete entries when timers fire — Map skips V8's hidden-class deopt
  // and gives us .clear() in one call on teardown.
  const pendingChangeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function trackSymlink(filePath: string) {
    if (symlinkPollers.has(filePath)) return;
    const handler = (curr: fs.Stats, prev: fs.Stats) => {
      if (curr.nlink === 0) {
        fs.unwatchFile(filePath, handler);
        symlinkPollers.delete(filePath);
        if (filePath in config.fsTree) {
          handleWatchEvent(config, extensions, 'unlink', filePath, onEventFunc, onFinishFunc);
        }
      } else if (curr.mtimeMs !== prev.mtimeMs) {
        // None of Windows (ReadDirectoryChangesW), macOS (FSEvents), or Linux (inotify) fire a
        // change event in the symlink's directory when writing through a symlink — only the
        // target's directory does, and the target may be outside the watched tree. fs.watchFile
        // stat-polls the symlink path (stat follows symlinks), so when the target's mtime moves,
        // we synthesize a change event for the symlink path here. Same per-file debounce as the
        // fs.watch 'change' path: a poll that lands mid-writeFile would otherwise dispatch a
        // rebuild against partial content.
        if (filePath in config.fsTree) {
          const existing = pendingChangeTimers.get(filePath);
          if (existing) clearTimeout(existing);
          pendingChangeTimers.set(
            filePath,
            setTimeout(() => {
              pendingChangeTimers.delete(filePath);
              handleWatchEvent(config, extensions, 'change', filePath, onEventFunc, onFinishFunc);
            }, CHANGE_COALESCE_MS),
          );
        }
      }
    };
    fs.watchFile(filePath, { interval: SYMLINK_POLL_INTERVAL_MS, persistent: false }, handler);
    symlinkPollers.set(filePath, () => fs.unwatchFile(filePath, handler));
  }

  function untrackSymlink(filePath: string) {
    symlinkPollers.get(filePath)?.();
    symlinkPollers.delete(filePath);
  }

  // A glob lookup path (`test/**/!(x).ts`) is not a real filesystem path, so fs.watch would ENOENT
  // on it. Collapse each lookup path to the deepest directory that actually exists — the glob's
  // base dir — and dedupe, so several globs under one tree share a single recursive watcher. Real
  // file/dir inputs pass through unchanged. The extension + fsTree filtering downstream still
  // decides which changes trigger a rerun, exactly as it does for a plain folder input.
  const watchRoots = [...new Set(testFileLookupPaths.map(toWatchableRoot))];

  for (const watchPath of watchRoots) {
    let ready = false;
    let rescanInProgress = false;
    // lastEventMs: wall-clock time the last event arrived (guards the 10ms burst window).
    // seenMtimeMs: file mtime recorded at the last event (fast-path kernel-duplicate filter).
    const lastEventMs: Record<string, number> = {};
    const seenMtimeMs: Record<string, number> = {};
    // lastRenameMs: per-path timestamp of the most recent 'rename' event, used to drop
    // duplicate rename events Deno's node:fs.watch compat fires under recursive watching
    // (observed: a single fs.rename produces 'rename subdir' twice in quick succession,
    // which without dedup would double-classify as unlinkDir and emit two "REMOVED:" lines).
    const lastRenameMs: Record<string, number> = {};
    // Needed so the change-event handler can attribute Deno's empty-filename
    // events (see below) to watchPath itself. One sync stat at setup time is
    // negligible (setupFileWatchers runs once at startup, before workers).
    const watchPathIsFile = fs.statSync(watchPath, { throwIfNoEntry: false })?.isFile() ?? false;

    // Child watcher: tracks file-level events within watchPath.
    const childWatcher = fs.watch(watchPath, { recursive: true }, async (eventType, filename) => {
      if (!ready) return;
      // Two distinct empty-filename cases:
      //   (a) macOS FSEvents coalesces under load and delivers events with
      //       filename=null for a directory; rescan recovers the delta.
      //   (b) Deno's node:fs.watch on a single FILE (not dir) with
      //       recursive:true fires 'change' with filename="" — no rescan
      //       applies because there is nothing to scan, but the event IS for
      //       watchPath itself. Treat it as basename(watchPath) so the
      //       existing fullPath derivation below picks it up.
      if (!filename) {
        if (watchPathIsFile) {
          filename = path.basename(watchPath);
        } else {
          if (process.platform === 'darwin' && !rescanInProgress) {
            rescanInProgress = true;
            rescanDirectoryForDelta(
              watchPath,
              config,
              extensions,
              onEventFunc,
              onFinishFunc,
              trackSymlink,
            ).finally(() => {
              rescanInProgress = false;
            });
          }
          return;
        }
      }
      // When watchPath is a file, fs.watch fires with filename = the file's own basename,
      // making path.join(watchPath, filename) produce the nonsense doubled path "foo.ts/foo.ts".
      const fullPath =
        filename === path.basename(watchPath) ? watchPath : path.join(watchPath, filename);

      if (eventType === 'change') {
        const now = Date.now();
        const last = lastEventMs[fullPath] ?? 0;
        lastEventMs[fullPath] = now;
        try {
          const { mtimeMs } = await stat(fullPath);
          const prevMtime = seenMtimeMs[fullPath] ?? 0;
          seenMtimeMs[fullPath] = mtimeMs;
          // Cheap kernel-duplicate filter: identical mtime within the 10ms burst window.
          // Real content changes are confirmed by hash at dispatch time (see below), so this
          // is only a fast-path to avoid re-reading the file for obvious inotify/FSEvents dups.
          if (now - last < CHANGE_DEDUPE_MS && mtimeMs > 0 && mtimeMs === prevMtime) return;
        } catch {
          // File inaccessible — proceed.
        }
        // Debounce: wait CHANGE_COALESCE_MS for the writeFile burst to settle, then dispatch a
        // rebuild only if the file's CONTENT actually changed (dispatchIfContentChanged hashes
        // it). Each new event resets the timer, so the file is fully written by dispatch time.
        const existing = pendingChangeTimers.get(fullPath);
        if (existing) clearTimeout(existing);
        pendingChangeTimers.set(
          fullPath,
          setTimeout(() => {
            pendingChangeTimers.delete(fullPath);
            dispatchIfContentChanged(config, extensions, fullPath, onEventFunc, onFinishFunc);
          }, CHANGE_COALESCE_MS),
        );
        return;
      }

      // Drop duplicate 'rename' events for the same path within RENAME_DEDUPE_MS.
      // Deno's node:fs.watch compat repeats them under recursive watching; without
      // this, a single fs.rename produces 'rename subdir' twice → cli classifies
      // each as unlinkDir → two "REMOVED:" log lines for one logical rename.
      const renameNow = Date.now();
      const lastRename = lastRenameMs[fullPath] ?? 0;
      if (renameNow - lastRename < RENAME_DEDUPE_MS) return;
      lastRenameMs[fullPath] = renameNow;

      // 'rename' event — stat to classify as add / addDir / unlink / unlinkDir.
      const event = await classifyRenameEvent(fullPath, config.fsTree);
      if (!event) return;

      if (event === 'add') {
        // If the added path is a symlink, set up deletion polling (fs.watch rename events are
        // not fired for symlink unlink on Linux, so polling is the only reliable detection).
        try {
          const lstatResult = await lstat(fullPath);
          if (lstatResult.isSymbolicLink()) trackSymlink(fullPath);
        } catch {
          /* path already gone */
        }
      } else if (event === 'unlink') {
        untrackSymlink(fullPath);
      }

      handleWatchEvent(config, extensions, event, fullPath, onEventFunc, onFinishFunc);
    });

    // Parent watcher: detects when watchPath itself is renamed or deleted.
    // fs.watch tracks inodes, so the child watcher keeps firing with stale paths after a rename;
    // watching the parent catches the disappearance of watchPath and fires unlinkDir.
    const parentDir = path.dirname(watchPath);
    const watchedBasename = path.basename(watchPath);
    // Guard against double-fire: Linux emits IN_MOVED_FROM + IN_MOVED_TO as two separate 'rename'
    // events on the parent. Both callbacks can reach this handler before either completes the async
    // stat(), so unlinkDir would fire twice without this synchronous guard flag. Also gates the
    // macOS rescan-timer fallback below — both code paths funnel through tryFireParentUnlink.
    let parentUnlinkFired = false;
    // Holds the macOS rescan timer (if any) so tryFireParentUnlink can clear it when the path
    // disappears — otherwise the timer keeps no-op-firing every second forever.
    let rescanTimer: ReturnType<typeof setInterval> | null = null;

    // Idempotent "watchPath is gone" handler. Sets the guard sync before the async stat so a
    // concurrent caller (parent watcher + rescan timer race on macOS) can't double-fire. Returns
    // true if watchPath was confirmed missing (and unlinkDir was fired), false otherwise.
    const tryFireParentUnlink = async (): Promise<boolean> => {
      if (parentUnlinkFired) return false;
      parentUnlinkFired = true;
      try {
        await stat(watchPath);
        parentUnlinkFired = false; // Still exists — spurious event.
        return false;
      } catch {
        handleWatchEvent(config, extensions, 'unlinkDir', watchPath, onEventFunc, onFinishFunc);
        childWatcher.close();
        parentWatcher.close();
        if (rescanTimer) clearInterval(rescanTimer);
        delete fileWatchers[watchPath];
        return true;
      }
    };

    const parentWatcher = fs.watch(parentDir, async (eventType, filename) => {
      if (!ready || filename !== watchedBasename || eventType !== 'rename') return;
      await tryFireParentUnlink();
    });
    parentWatchers.push(parentWatcher);
    fileWatchers[watchPath] = childWatcher;

    // Gate readiness on the content-hash seed: the change handler and rescan both drop events
    // until `ready`, so seeding always finishes before any write is processed (see seedPromise).
    readyPromises.push(
      seedPromise.then(
        () =>
          new Promise<void>((resolve) =>
            setImmediate(() => {
              ready = true;
              resolve();
            }),
          ),
      ),
    );

    // Safety-net for macOS: FSEvents can drop all events for a directory rename under load
    // (e.g. Firefox running concurrently). Periodic rescan catches missed removals/additions
    // *inside* watchPath via rescanDirectoryForDelta, AND missed disappearance of watchPath
    // itself via tryFireParentUnlink — without that second branch, a dropped parent rename
    // event leaves unlinkDir un-fired forever (observed: run 25090075388 timed out at 120 s).
    //
    // Also on Linux when running under Deno: deno's node:fs.watch compat silently drops
    // symlink creation/rename events under recursive watching, so the rescan plays the same
    // role — picks up newly-added symlinks and missed unlinks the kernel notify path didn't
    // surface. See test/flags/watch-rerun-test.ts "adding a symlink ..." / "renaming a
    // symlink ..." for the failing scenarios this catches.
    if (process.platform === 'darwin' || IS_DENO) {
      rescanTimer = setInterval(async () => {
        if (!ready || rescanInProgress || parentUnlinkFired) return;
        if (await tryFireParentUnlink()) return;
        rescanInProgress = true;
        rescanDirectoryForDelta(
          watchPath,
          config,
          extensions,
          onEventFunc,
          onFinishFunc,
          trackSymlink,
        ).finally(() => {
          rescanInProgress = false;
        });
      }, RESCAN_INTERVAL_MS);
      rescanTimer.unref();
      rescanTimers.push(rescanTimer);
    }
  }

  // Scan the initial fsTree for symlinks and set up deletion polling for each.
  // This covers symlinks that already existed when the watcher started — without this, only
  // symlinks added after startup would get polling (via the child watcher 'add' path above).
  readyPromises.push(
    (async () => {
      for (const filePath of Object.keys(config.fsTree)) {
        try {
          const lstatResult = await lstat(filePath);
          if (lstatResult.isSymbolicLink()) trackSymlink(filePath);
        } catch {
          /* file gone or inaccessible — skip */
        }
      }
    })(),
  );

  return {
    fileWatchers,
    ready: Promise.all(readyPromises).then(() => {}),
    killFileWatchers() {
      Object.keys(fileWatchers).forEach((key) => fileWatchers[key].close());
      parentWatchers.forEach((pw) => pw.close());
      rescanTimers.forEach((t) => clearInterval(t));
      symlinkPollers.forEach((cancel) => cancel());
      symlinkPollers.clear();
      pendingChangeTimers.forEach((t) => clearTimeout(t));
      pendingChangeTimers.clear();
      return fileWatchers;
    },
  };
}

/**
 * Routes a file-system event to fsTree mutation and optional rebuild trigger.
 * `unlinkDir` bypasses the extension filter so deleted directories always clean up fsTree.
 * When a build is already in progress, queues the event as a pending trigger (last-write-wins).
 */
export function handleWatchEvent(
  config: Config,
  extensions: string[],
  event: string,
  filePath: string,
  onEventFunc: (event: string, file: string) => unknown,
  onFinishFunc: ((path: string, event: string) => void) | null | undefined,
): Promise<void> {
  if (event !== 'unlinkDir' && !extensions.some((ext) => filePath.endsWith(`.${ext}`)))
    return Promise.resolve();

  // Spurious 'change' fires after 'add' when inotify flushes content after rename.
  // Ignore it while the add's build is running so it doesn't queue a redundant full re-run.
  if (
    event === 'change' &&
    config.state.watch.building &&
    config.state.watch.justAddedFiles.has(filePath)
  )
    return Promise.resolve();

  // Same race, post-build: Windows fs.watch fires a trailing 'change' AFTER the add's
  // build completes, which the `building` gate above misses. See ADD_SUPPRESS_WINDOW_MS.
  if (event === 'change') {
    const addedAt = config.state.watch.justAddedAt.get(filePath);
    if (addedAt !== undefined && Date.now() - addedAt < ADD_SUPPRESS_WINDOW_MS)
      return Promise.resolve();
  }

  mutateFSTree(config.fsTree, event, filePath);

  console.log(
    '#',
    magenta().bold('=================================================================='),
  );
  const displayPath = filePath.startsWith(config.projectRoot)
    ? filePath.slice(config.projectRoot.length)
    : filePath;
  console.log('#', colorEvent(event), displayPath);
  console.log(
    '#',
    magenta().bold('=================================================================='),
  );

  if (event === 'add') config.state.watch.justAddedAt.set(filePath, Date.now());

  if (config.state.watch.building) {
    // Queue this event so it fires immediately after the current build finishes (last-write-wins).
    // Track added files so their spurious post-add change events are also filtered above.
    if (event === 'add') config.state.watch.justAddedFiles.add(filePath);
    config.state.watch.pendingBuildTrigger = () =>
      handleWatchEvent(config, extensions, event, filePath, onEventFunc, onFinishFunc);
    return Promise.resolve();
  }

  config.state.watch.building = true;
  config.state.watch.justAddedFiles = event === 'add' ? new Set([filePath]) : new Set();

  const result = onEventFunc(event, filePath);

  if (!(result instanceof Promise)) {
    config.state.watch.building = false;
    return Promise.resolve();
  }

  return result
    .then(() => onFinishFunc?.(filePath, event))
    .catch((error) => console.error('#', red('Build error:'), error.message || error))
    .finally(() => {
      config.state.watch.building = false;
      // Only advance the "last successful build" timestamp on a clean build. A failed
      // build (esbuild bundle error) leaves no successfully-built content, so keeping the
      // timestamp pinned to the last good build means the echo-suppression below (and the
      // rescan path) won't fence out the user's fix — which on coarse-mtime filesystems
      // (CI overlayfs) can land in the same/earlier second as the failed build's end and
      // otherwise gets dropped, hanging watch mode on the error until an unrelated change.
      if (!config.state.watch.lastBuildErrored) {
        config.state.watch.lastBuildEndMs = Date.now();
      } else {
        // A failed build leaves the bundle broken, so the content-hash baseline is stale: drop this
        // file's entry so the fix re-fires even when it reverts to the last successfully-built
        // content (identical hash). Otherwise a build-error → revert cycle hangs on macOS, where
        // the error's write can arrive as an fs.watch 'rename' that never advanced the baseline.
        delete config.state.watch.builtContentHash[filePath];
      }
      if (config.state.watch.pendingBuildTrigger) {
        const trigger = config.state.watch.pendingBuildTrigger;
        config.state.watch.pendingBuildTrigger = null;
        trigger();
      }
    });
}

/**
 * Scans `watchPath` recursively and fires `add` / `change` / `unlink` events for any delta
 * between the directory contents and `config.fsTree`. Used as a 1 s safety-net poll on macOS
 * where FSEvents can drop events under load — additions and removals are recovered from the
 * directory listing, and modifications are recovered by re-stat'ing every tracked file and
 * firing `change` whenever its mtime is newer than `config.state.watch.lastBuildEndMs` (the moment the
 * last build saw the file). The seed for that baseline is set in {@link setupFileWatchers}.
 */
export async function rescanDirectoryForDelta(
  watchPath: string,
  config: Config,
  extensions: string[],
  onEventFunc: (event: string, file: string) => unknown,
  onFinishFunc: ((path: string, event: string) => void) | null | undefined,
  trackSymlinkFn?: (filePath: string) => void,
): Promise<void> {
  try {
    const entries = await readdir(watchPath, { withFileTypes: true, recursive: true });
    const presentPaths = new Set<string>();
    // presentDirs tracks every directory confirmed present on disk — used below to detect which
    // ancestor directory was removed without issuing additional stat() calls.
    const presentDirs = new Set<string>();
    presentDirs.add(watchPath);
    const trackedToRecheck: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        presentDirs.add(path.join(entry.parentPath, entry.name));
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const entryPath = path.join(entry.parentPath, entry.name);
      presentDirs.add(entry.parentPath);
      if (!extensions.some((ext) => entryPath.endsWith(`.${ext}`))) continue;
      presentPaths.add(entryPath);
      if (!(entryPath in config.fsTree)) {
        if (entry.isSymbolicLink()) trackSymlinkFn?.(entryPath);
        handleWatchEvent(config, extensions, 'add', entryPath, onEventFunc, onFinishFunc);
      } else if (config.state.watch.lastBuildEndMs) {
        trackedToRecheck.push(entryPath);
      }
    }
    // Detect modifies fs.watch may have dropped: re-check every tracked file whose mtime is
    // recent enough to be a candidate, then confirm a genuine change by content hash. mtime is
    // only a coarse first filter — widened by RESCAN_MTIME_GRACE_MS because macOS/HFS+ reports
    // 1-second mtime resolution, so a write in the same second as the last build must still be
    // considered. The hash (in dispatchIfContentChanged) is what actually distinguishes a new
    // write from an untouched file, so pre-existing files are never spuriously rebuilt.
    const buildEndMs = config.state.watch.lastBuildEndMs;
    await Promise.all(
      trackedToRecheck.map(async (filePath) => {
        try {
          const { mtimeMs } = await stat(filePath);
          if (mtimeMs < buildEndMs - RESCAN_MTIME_GRACE_MS) return;
          await dispatchIfContentChanged(config, extensions, filePath, onEventFunc, onFinishFunc);
        } catch {
          /* file disappeared between readdir and stat — handled by the unlink pass below */
        }
      }),
    );
    const watchPrefix = watchPath + path.sep;
    // For each missing tracked path, walk up toward watchPath using presentDirs (O(1) Set
    // lookups, no extra I/O) to find the highest gone ancestor. Fire one unlinkDir for the
    // whole subtree rather than N individual unlinks (each of which emits a REMOVED: line).
    const firedDirPrefixes: string[] = [];
    for (const trackedPath of Object.keys(config.fsTree)) {
      if (!trackedPath.startsWith(watchPrefix) || presentPaths.has(trackedPath)) continue;
      if (firedDirPrefixes.some((p) => trackedPath.startsWith(p + path.sep))) continue;
      const parts = trackedPath.slice(watchPrefix.length).split(path.sep);
      const goneDirPath =
        parts
          .slice(0, -1)
          .map((_, i) => watchPrefix + parts.slice(0, i + 1).join(path.sep))
          .find((p) => !presentDirs.has(p)) ?? null;
      if (goneDirPath !== null) {
        firedDirPrefixes.push(goneDirPath);
        handleWatchEvent(config, extensions, 'unlinkDir', goneDirPath, onEventFunc, onFinishFunc);
      } else {
        handleWatchEvent(config, extensions, 'unlink', trackedPath, onEventFunc, onFinishFunc);
      }
    }
  } catch {
    /* watchPath may no longer exist */
  }
}

/**
 * Mutates `fsTree` in place based on a file-system event.
 */
export function mutateFSTree(fsTree: FSTree, event: string, filePath: string): void {
  if (event === 'add') {
    fsTree[filePath] = null;
  } else if (event === 'unlink') {
    delete fsTree[filePath];
  } else if (event === 'unlinkDir') {
    // Check both '/' and '\\' so POSIX-style paths (used in unit tests and Linux/macOS) and
    // Windows native paths (backslash) are both matched correctly regardless of platform.
    for (const treePath of Object.keys(fsTree)) {
      if (treePath.startsWith(filePath + '/') || treePath.startsWith(filePath + '\\'))
        delete fsTree[treePath];
    }
  }
}

export { setupFileWatchers as default };

/**
 * Resolves the event type for a 'rename' kernel event by stat-ing the path.
 * On macOS (FSEvents) plain file writes frequently arrive as 'rename' instead of 'change';
 * if the path is already tracked in fsTree we return 'change' (modification) rather than 'add'.
 * Retries once after 50ms for overlayfs (Docker CI) copy-on-write transient unavailability.
 * Returns null when the path is unknown and has no tracked children (safe to ignore).
 */
async function classifyRenameEvent(
  fullPath: string,
  fsTree: FSTree | undefined,
): Promise<string | null> {
  for (const delay of [0, OVERLAYFS_RENAME_RETRY_MS]) {
    if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    try {
      const statResult = await stat(fullPath);
      if (statResult.isDirectory()) return 'addDir';
      return fsTree && fullPath in fsTree ? 'change' : 'add';
    } catch {
      // File/dir not yet available — retry or fall through to unlink classification.
    }
  }

  // stat failed on both attempts — file/dir is genuinely gone.
  if (!fsTree) return null;
  if (fullPath in fsTree) return 'unlink';
  // Check whether it was a directory that still has tracked children. fs.watch fires one 'rename'
  // event for the directory itself (not per-child), so we coalesce all child removals into one
  // unlinkDir rather than silently ignoring the event.
  return Object.keys(fsTree).some(
    (trackedPath) =>
      trackedPath.startsWith(fullPath + '/') || trackedPath.startsWith(fullPath + '\\'),
  )
    ? 'unlinkDir'
    : null;
}

function colorEvent(event: string): unknown {
  if (event === 'change') return yellow('CHANGED:');
  if (event === 'add' || event === 'addDir') return green('ADDED:');
  return red('REMOVED:');
}

/**
 * Maps a lookup path to a path fs.watch can actually watch. A real file or directory is returned
 * as-is; a glob is walked up to the deepest ancestor directory that exists — its base dir — which
 * fs.watch can watch recursively (`test/x/!(plugin).ts` collapses to `test/x`).
 */
export function toWatchableRoot(lookupPath: string): string {
  if (fs.existsSync(lookupPath)) return lookupPath;

  // "Try the parent, else its parent" — recursion says that directly, where the loop had to step up
  // and test in separate statements. It stops at the first hit exactly as the loop did, so the
  // syscall count is unchanged and no ancestor list is materialised. Depth is path segments.
  const deepestExisting = (dir: string): string => {
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    if (fs.existsSync(parent) && fs.statSync(parent).isDirectory()) {
      // Only reachable when a path's whole chain is missing (never for real cwd-joined inputs) and
      // the sole existing ancestor is the filesystem root. Floor at cwd rather than hand fs.watch a
      // root, which would recursively watch the entire disk.
      return parent === path.parse(parent).root ? process.cwd() : parent;
    }

    return deepestExisting(parent);
  };

  return deepestExisting(lookupPath);
}
