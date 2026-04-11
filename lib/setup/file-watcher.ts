import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { green, magenta, red, yellow } from '../utils/color.ts';
import type { FSWatcher } from 'node:fs';
import type { Config, FSTree } from '../types.ts';

/**
 * Starts `fs.watch` watchers for each lookup path and calls `onEventFunc` on JS/TS file changes,
 * debounced via a flag. Also watches each path's parent directory to detect when a watched
 * directory is renamed or deleted (since fs.watch tracks by inode, not path).
 * Uses `config.fsTree` to distinguish `unlink` (tracked file) from `unlinkDir` (directory) on deletion.
 * @returns {object}
 */
export default function setupFileWatchers(
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

  const fileWatchers = testFileLookupPaths.reduce((watchers, watchPath) => {
    let ready = false;
    // Per-file timestamps of the last processed 'change' event.
    // inotify (Linux) and FSEvents (macOS) often emit 2–3 change events per
    // writeFile; if esbuild finishes between events (fast for small files),
    // _building is already false and each event triggers a redundant build.
    // A 30 ms deduplication window coalesces these without adding noticeable lag.
    const lastChangeMs: Record<string, number> = {};
    const CHANGE_DEDUPE_MS = 30;

    // Child watcher: tracks file-level events within watchPath.
    const childWatcher = fs.watch(watchPath, { recursive: true }, async (eventType, filename) => {
      if (!ready || !filename) return;
      const fullPath = path.join(watchPath, filename);
      if (eventType === 'change') {
        // Only deduplicate when no build is already in progress. When _building is true,
        // the pending-trigger mechanism (last-write-wins) already coalesces concurrent events;
        // applying the debounce there could suppress a later valid-file event if it arrives
        // within CHANGE_DEDUPE_MS of an earlier invalid-file event that was itself only queued.
        if (!config._building) {
          const now = Date.now();
          if (now - (lastChangeMs[fullPath] ?? 0) < CHANGE_DEDUPE_MS) {
            // Even within the dedup window, let the event through if a build has completed since
            // the last recorded change time: the current event is a new write (e.g. "fix" after a
            // failed build), not a duplicate inotify event for the same write. Without this check,
            // a fast-failing build (< 30ms) followed by an immediate new write causes the fix's
            // change event to be silently dropped, leaving watch mode stuck.
            if (
              !config._lastBuildEndMs ||
              config._lastBuildEndMs <= (lastChangeMs[fullPath] ?? 0)
            ) {
              return;
            }
          }
          lastChangeMs[fullPath] = now;
        }
        return handleWatchEvent(config, extensions, 'change', fullPath, onEventFunc, onFinishFunc);
      }
      try {
        const s = await stat(fullPath);
        handleWatchEvent(
          config,
          extensions,
          s.isDirectory() ? 'addDir' : 'add',
          fullPath,
          onEventFunc,
          onFinishFunc,
        );
      } catch {
        // stat failed on the first attempt. On overlayfs (Docker CI), a writeFile triggers
        // IN_DELETE + IN_CREATE via copy-on-write semantics, making the file temporarily
        // unavailable. Retry once after 50 ms before concluding the file is genuinely gone.
        // Without this, the unlink path empties config.fsTree and produces a 110-byte bundle.
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        try {
          const s = await stat(fullPath);
          handleWatchEvent(
            config,
            extensions,
            s.isDirectory() ? 'addDir' : 'add',
            fullPath,
            onEventFunc,
            onFinishFunc,
          );
          return;
        } catch {
          // Still unavailable after retry — treat as a genuine unlink.
        }
        // stat failed — either the file was deleted or the event carried a stale/wrong path.
        if (config.fsTree && fullPath in config.fsTree) {
          // Confirmed tracked file — fire a single 'unlink'.
          handleWatchEvent(config, extensions, 'unlink', fullPath, onEventFunc, onFinishFunc);
          return;
        }
        // Not a tracked file path. Check whether it is a subdirectory that still has tracked
        // files under it. This handles the case where a nested directory inside the watched
        // path is renamed/deleted: fs.watch fires one 'rename' event for the directory itself
        // (filename = 'subdir') but no individual events for its contents. Firing 'unlinkDir'
        // here coalesces all child file removals into a single rebuild instead of silently
        // dropping the event (old behaviour) or triggering N individual unlink rebuilds.
        if (!config.fsTree) return;
        const dirPrefix = fullPath + '/';
        const hasTrackedChildren = Object.keys(config.fsTree).some((p) => p.startsWith(dirPrefix));
        if (!hasTrackedChildren) return;
        handleWatchEvent(config, extensions, 'unlinkDir', fullPath, onEventFunc, onFinishFunc);
      }
    });

    // Parent watcher: detects when watchPath itself is renamed or deleted.
    // fs.watch tracks inodes, so the child watcher would keep firing after a directory rename
    // but path.join(watchPath, filename) would use the stale original path. Watching the parent
    // catches the disappearance of watchPath and fires unlinkDir to clean up tracked files.
    const parentDir = path.dirname(watchPath);
    const watchedBasename = path.basename(watchPath);
    // Guard against concurrent callbacks: on Linux, a directory rename fires both IN_MOVED_FROM
    // and IN_MOVED_TO as separate 'rename' events on the parent. Both callbacks can pass the
    // initial guard checks before either reaches the async stat(), causing unlinkDir to fire
    // twice. Setting this flag synchronously (before the first await) ensures the second
    // concurrent callback exits immediately.
    let parentUnlinkFired = false;
    const parentWatcher = fs.watch(parentDir, async (eventType, filename) => {
      if (!ready || filename !== watchedBasename || eventType !== 'rename') return;
      if (parentUnlinkFired) return;
      parentUnlinkFired = true;
      try {
        await stat(watchPath);
        // Directory still exists — spurious event; reset so future rename events are handled.
        parentUnlinkFired = false;
      } catch {
        // watchPath was renamed or deleted. Fire unlinkDir so fsTree is cleaned up and a
        // re-run is triggered, then close both watchers to stop stale-path events.
        handleWatchEvent(config, extensions, 'unlinkDir', watchPath, onEventFunc, onFinishFunc);
        childWatcher.close();
        parentWatcher.close();
        delete watchers[watchPath];
      }
    });
    parentWatchers.push(parentWatcher);

    readyPromises.push(
      new Promise<void>((resolve) =>
        setImmediate(() => {
          ready = true;
          resolve();
        }),
      ),
    );
    return Object.assign(watchers, { [watchPath]: childWatcher });
  }, {});

  return {
    fileWatchers,
    ready: Promise.all(readyPromises).then(() => {}),
    killFileWatchers() {
      Object.keys(fileWatchers).forEach((key) => fileWatchers[key].close());
      parentWatchers.forEach((pw) => pw.close());
      return fileWatchers;
    },
  };
}

/**
 * Routes a file-system event to fsTree mutation and optional rebuild trigger.
 * `unlinkDir` bypasses the extension filter so deleted directories always clean up fsTree.
 * When a build is already in progress, queues the event as a pending trigger so it fires
 * immediately after the current build completes (last-write-wins for rapid changes).
 * @returns {void}
 */
export function handleWatchEvent(
  config: Config,
  extensions: string[],
  event: string,
  filePath: string,
  onEventFunc: (event: string, file: string) => unknown,
  onFinishFunc: ((path: string, event: string) => void) | null | undefined,
): void {
  const isFileEvent = extensions.some((ext) => filePath.endsWith(`.${ext}`));

  if (!isFileEvent && event !== 'unlinkDir') return;

  // Spurious 'change' events fire after 'add' (inotify flushes content after rename).
  // Ignore them while the add's filtered run is in progress so they don't queue a full re-run.
  if (event === 'change' && config._building && config._justAddedFiles?.has(filePath)) return;

  mutateFSTree(config.fsTree, event, filePath);

  console.log(
    '#',
    magenta().bold('=================================================================='),
  );
  console.log('#', getEventColor(event), filePath.split(config.projectRoot)[1]);
  console.log(
    '#',
    magenta().bold('=================================================================='),
  );

  if (!config._building) {
    config._building = true;
    // Record which file triggered this build so spurious post-add change events are filtered above.
    config._justAddedFiles = event === 'add' ? new Set([filePath]) : new Set();

    const result = onEventFunc(event, filePath);

    if (!(result instanceof Promise)) {
      config._building = false;

      return result;
    }

    result
      .then(() => {
        onFinishFunc ? onFinishFunc(event, filePath) : null;
      })
      .catch((error) => {
        console.error('#', red('Build error:'), error.message || error);
      })
      .finally(() => {
        config._building = false;
        config._lastBuildEndMs = Date.now();
        // Fire the last event that arrived while we were building (last-write-wins).
        if (config._pendingBuildTrigger) {
          const trigger = config._pendingBuildTrigger;
          config._pendingBuildTrigger = null;
          trigger();
        }
      });
  } else {
    // A build is in progress — queue this event, overwriting any previous pending one.
    // The finally block above will pick it up after the current build finishes.
    // If the pending event is an 'add', track the file so its spurious post-creation
    // change events are also filtered above (handles rapid multi-file add sequences).
    if (event === 'add') config._justAddedFiles?.add(filePath);
    config._pendingBuildTrigger = () =>
      handleWatchEvent(config, extensions, event, filePath, onEventFunc, onFinishFunc);
  }
}

/**
 * Mutates `fsTree` in place based on a chokidar file-system event.
 * @returns {void}
 */
export function mutateFSTree(fsTree: FSTree, event: string, path: string): void {
  if (event === 'add') {
    fsTree[path] = null;
  } else if (event === 'unlink') {
    delete fsTree[path];
  } else if (event === 'unlinkDir') {
    // Append the path separator so that sibling directories that share a name prefix are not
    // incorrectly matched. e.g. removing 'tests/' must not delete 'tests2/foo.ts' entries.
    const dirPrefix = path.endsWith('/') ? path : path + '/';
    for (const treePath of Object.keys(fsTree)) {
      if (treePath.startsWith(dirPrefix)) delete fsTree[treePath];
    }
  }
}

function getEventColor(event: string): unknown {
  if (event === 'change') {
    return yellow('CHANGED:');
  } else if (event === 'add' || event === 'addDir') {
    return green('ADDED:');
  } else if (event === 'unlink' || event === 'unlinkDir') {
    return red('REMOVED:');
  }
}
