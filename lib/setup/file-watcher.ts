import fs from 'node:fs';
import { stat, lstat } from 'node:fs/promises';
import path from 'node:path';
import { green, magenta, red, yellow } from '../utils/color.ts';
import type { FSWatcher } from 'node:fs';
import type { Config, FSTree } from '../types.ts';

const CHANGE_DEDUPE_MS = 10;

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
  const extensions = config.extensions || ['js', 'ts'];
  const readyPromises: Promise<void>[] = [];
  const parentWatchers: FSWatcher[] = [];
  const fileWatchers: Record<string, FSWatcher> = {};
  // Cancellers for fs.watchFile polls on symlink files.
  // On Linux, fs.unlink on a symlink fires NO fs.watch rename event, so the child watcher
  // never sees the deletion. fs.watchFile (stat-polling) fills that gap: when stat() on the
  // symlink path fails (symlink deleted or target gone/moved), nlink drops to 0 and we
  // synthesize an 'unlink' event. A 500 ms interval balances latency vs CPU cost.
  const symlinkPollers = new Map<string, () => void>();

  function trackSymlink(filePath: string) {
    if (symlinkPollers.has(filePath)) return;
    const handler = (curr: fs.Stats) => {
      if (curr.nlink === 0) {
        fs.unwatchFile(filePath, handler);
        symlinkPollers.delete(filePath);
        if (filePath in config.fsTree) {
          handleWatchEvent(config, extensions, 'unlink', filePath, onEventFunc, onFinishFunc);
        }
      }
    };
    fs.watchFile(filePath, { interval: 500, persistent: false }, handler);
    symlinkPollers.set(filePath, () => fs.unwatchFile(filePath, handler));
  }

  function untrackSymlink(filePath: string) {
    symlinkPollers.get(filePath)?.();
    symlinkPollers.delete(filePath);
  }

  for (const watchPath of testFileLookupPaths) {
    let ready = false;
    // Per-file timestamps of the last processed 'change' event.
    // inotify/FSEvents often fire 2–3 change events per writeFile; a 10ms dedup window coalesces
    // them. inotify multi-fires (IN_MODIFY + IN_CLOSE_WRITE) arrive within 1–2ms of each other,
    // so 10ms is safely above the noise floor without adding perceptible lag to watch rebuilds.
    // See _lastBuildEndMs bypass in the child watcher below.
    const lastChangeMs: Record<string, number> = {};

    // Child watcher: tracks file-level events within watchPath.
    const childWatcher = fs.watch(watchPath, { recursive: true }, async (eventType, filename) => {
      if (!ready || !filename) return;
      // When watchPath is a file, fs.watch fires with filename = the file's own basename,
      // making path.join(watchPath, filename) produce the nonsense doubled path "foo.ts/foo.ts".
      const fullPath =
        filename === path.basename(watchPath) ? watchPath : path.join(watchPath, filename);

      if (eventType === 'change') {
        if (!config._building) {
          const now = Date.now();
          const last = lastChangeMs[fullPath] ?? 0;
          if (now - last < CHANGE_DEDUPE_MS) {
            // Let the event through if a build completed after the last recorded change: the
            // current write is new (e.g. "fix" after a fast-failing build), not a duplicate
            // inotify event for the same write. Without this bypass, watch mode gets stuck.
            if (!config._lastBuildEndMs || config._lastBuildEndMs <= last) return;
          }
          lastChangeMs[fullPath] = now;
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
      symlinkPollers.forEach((cancel) => cancel());
      symlinkPollers.clear();
      return fileWatchers;
    },
  };
}

/**
 * Resolves the event type for an inotify 'rename' event by stat-ing the path.
 * Retries once after 50ms for overlayfs (Docker CI) copy-on-write transient unavailability.
 * Returns null when the path is unknown and has no tracked children (safe to ignore).
 */
async function classifyRenameEvent(
  fullPath: string,
  fsTree: FSTree | undefined,
): Promise<string | null> {
  for (const delay of [0, 50]) {
    if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    try {
      const statResult = await stat(fullPath);
      return statResult.isDirectory() ? 'addDir' : 'add';
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
  const dirPrefix = fullPath + '/';
  return Object.keys(fsTree).some((trackedPath) => trackedPath.startsWith(dirPrefix))
    ? 'unlinkDir'
    : null;
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
 * Mutates `fsTree` in place based on a file-system event.
 */
export function mutateFSTree(fsTree: FSTree, event: string, path: string): void {
  if (event === 'add') {
    fsTree[path] = null;
  } else if (event === 'unlink') {
    delete fsTree[path];
  } else if (event === 'unlinkDir') {
    // Append the path separator so sibling directories sharing a name prefix are not incorrectly
    // matched. e.g. removing 'tests/' must not delete 'tests2/foo.ts' entries.
    const dirPrefix = path.endsWith('/') ? path : path + '/';
    for (const treePath of Object.keys(fsTree)) {
      if (treePath.startsWith(dirPrefix)) delete fsTree[treePath];
    }
  }
}

function colorEvent(event: string): unknown {
  if (event === 'change') return yellow('CHANGED:');
  if (event === 'add' || event === 'addDir') return green('ADDED:');
  return red('REMOVED:');
}

export { setupFileWatchers as default };
