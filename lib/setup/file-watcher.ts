import fs from 'node:fs';
import { readdir, stat, lstat } from 'node:fs/promises';
import path from 'node:path';
import { green, magenta, red, yellow } from '../utils/color.ts';
import { defaultProjectConfigValues } from './default-project-config-values.ts';
import type { FSWatcher } from 'node:fs';
import type { Config, FSTree } from '../types.ts';

const CHANGE_DEDUPE_MS = 10;
const SYMLINK_POLL_INTERVAL_MS = 500;
const OVERLAYFS_RENAME_RETRY_MS = 50;
const RESCAN_INTERVAL_MS = 1_000;

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
  // runs directly from run.ts), so on a failed initial build _lastBuildEndMs would otherwise
  // stay undefined and the rescan could not distinguish stale files from genuine modifications.
  config._lastBuildEndMs ??= Date.now();
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

  function trackSymlink(filePath: string) {
    if (symlinkPollers.has(filePath)) return;
    const handler = (curr: fs.Stats, prev: fs.Stats) => {
      if (curr.nlink === 0) {
        fs.unwatchFile(filePath, handler);
        symlinkPollers.delete(filePath);
        if (filePath in config.fsTree) {
          handleWatchEvent(config, extensions, 'unlink', filePath, onEventFunc, onFinishFunc);
        }
      } else if (
        (process.platform === 'win32' || process.platform === 'darwin') &&
        curr.mtimeMs !== prev.mtimeMs
      ) {
        // Windows (ReadDirectoryChangesW) and macOS (FSEvents) do not fire change events in the
        // symlink's directory when writing through a symlink — only the target's directory gets
        // the event. fs.watchFile stat-polls the symlink path (stat follows symlinks), so when
        // the target's mtime changes, we synthesize a change event for the symlink path here.
        if (filePath in config.fsTree) {
          handleWatchEvent(config, extensions, 'change', filePath, onEventFunc, onFinishFunc);
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

  for (const watchPath of testFileLookupPaths) {
    let ready = false;
    let rescanInProgress = false;
    // lastEventMs: wall-clock time the last event arrived (guards the 10ms burst window).
    // seenMtimeMs: file mtime recorded at the last event (detects echoes vs genuine new writes).
    const lastEventMs: Record<string, number> = {};
    const seenMtimeMs: Record<string, number> = {};

    // Child watcher: tracks file-level events within watchPath.
    const childWatcher = fs.watch(watchPath, { recursive: true }, async (eventType, filename) => {
      if (!ready) return;
      // macOS FSEvents can coalesce events and deliver rename with filename=null under load.
      // Rescan the directory to find any new/removed files that the null event may be reporting.
      if (!filename) {
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
          // Suppress inotify/FSEvents kernel duplicates: same mtime within the burst window.
          // Genuine new writes have a strictly newer mtime and are always let through — even
          // during a running build — so the pending-trigger mechanism sees the latest content.
          if (now - last < CHANGE_DEDUPE_MS && mtimeMs > 0 && mtimeMs === prevMtime) return;
          // Suppress overlayfs late IN_CLOSE_WRITE echoes (arrive 100ms–1s after IN_MODIFY):
          // if the file's mtime predates the last build (second-aligned, 1s overlayfs resolution),
          // that content was already processed. Using `<` (not `<=`) lets writes in the same
          // second as the build end through (e.g. an immediate fix after a build error).
          if (config._lastBuildEndMs && mtimeMs < Math.floor(config._lastBuildEndMs / 1000) * 1000)
            return;
        } catch {
          // File inaccessible — proceed.
        }
        return handleWatchEvent(config, extensions, 'change', fullPath, onEventFunc, onFinishFunc);
      }

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
    // stat(), so unlinkDir would fire twice without this synchronous guard flag.
    let parentUnlinkFired = false;
    const parentWatcher = fs.watch(parentDir, async (eventType, filename) => {
      if (!ready || filename !== watchedBasename || eventType !== 'rename') return;
      if (parentUnlinkFired) return;
      parentUnlinkFired = true;
      try {
        await stat(watchPath);
        parentUnlinkFired = false; // Still exists — spurious event.
      } catch {
        handleWatchEvent(config, extensions, 'unlinkDir', watchPath, onEventFunc, onFinishFunc);
        childWatcher.close();
        parentWatcher.close();
        delete fileWatchers[watchPath];
      }
    });
    parentWatchers.push(parentWatcher);
    fileWatchers[watchPath] = childWatcher;

    readyPromises.push(
      new Promise<void>((resolve) =>
        setImmediate(() => {
          ready = true;
          resolve();
        }),
      ),
    );

    // Safety-net for macOS: FSEvents can drop all events for a directory rename under load
    // (e.g. Firefox running concurrently). Periodic rescan catches missed removals/additions.
    if (process.platform === 'darwin') {
      rescanTimers.push(
        setInterval(() => {
          if (!ready || rescanInProgress) return;
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
        }, RESCAN_INTERVAL_MS).unref(),
      );
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
  if (event === 'change' && config._building && config._justAddedFiles?.has(filePath))
    return Promise.resolve();

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

  if (config._building) {
    // Queue this event so it fires immediately after the current build finishes (last-write-wins).
    // Track added files so their spurious post-add change events are also filtered above.
    if (event === 'add') config._justAddedFiles?.add(filePath);
    config._pendingBuildTrigger = () =>
      handleWatchEvent(config, extensions, event, filePath, onEventFunc, onFinishFunc);
    return Promise.resolve();
  }

  config._building = true;
  config._justAddedFiles = event === 'add' ? new Set([filePath]) : new Set();

  const result = onEventFunc(event, filePath);

  if (!(result instanceof Promise)) {
    config._building = false;
    return Promise.resolve();
  }

  return result
    .then(() => onFinishFunc?.(filePath, event))
    .catch((error) => console.error('#', red('Build error:'), error.message || error))
    .finally(() => {
      config._building = false;
      config._lastBuildEndMs = Date.now();
      if (config._pendingBuildTrigger) {
        const trigger = config._pendingBuildTrigger;
        config._pendingBuildTrigger = null;
        trigger();
      }
    });
}

/**
 * Scans `watchPath` recursively and fires `add` / `change` / `unlink` events for any delta
 * between the directory contents and `config.fsTree`. Used as a 1 s safety-net poll on macOS
 * where FSEvents can drop events under load — additions and removals are recovered from the
 * directory listing, and modifications are recovered by re-stat'ing every tracked file and
 * firing `change` whenever its mtime is newer than `config._lastBuildEndMs` (the moment the
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
      } else if (config._lastBuildEndMs) {
        trackedToRecheck.push(entryPath);
      }
    }
    // Detect modifies fs.watch may have dropped: stat every tracked file in parallel and
    // fire 'change' when its mtime is strictly newer than the last build's end. setupFileWatchers
    // seeds _lastBuildEndMs at startup, so on the first rescan tick this only fires for files
    // genuinely modified after the watcher came up — never for pre-existing untouched files.
    const buildEndMs = config._lastBuildEndMs ?? 0;
    await Promise.all(
      trackedToRecheck.map(async (filePath) => {
        try {
          const { mtimeMs } = await stat(filePath);
          if (mtimeMs > buildEndMs) {
            handleWatchEvent(config, extensions, 'change', filePath, onEventFunc, onFinishFunc);
          }
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
