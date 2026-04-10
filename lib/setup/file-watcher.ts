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
          if (now - (lastChangeMs[fullPath] ?? 0) < CHANGE_DEDUPE_MS) return;
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
        // stat failed — either the file was deleted or the event carried a stale/wrong path.
        // Only act when we can confirm the path was previously tracked; otherwise ignore.
        // Spurious unlinkDir for unknown paths clears allTestCode and triggers a full run.
        if (!(config.fsTree && fullPath in config.fsTree)) return;
        handleWatchEvent(config, extensions, 'unlink', fullPath, onEventFunc, onFinishFunc);
      }
    });

    // Parent watcher: detects when watchPath itself is renamed or deleted.
    // fs.watch tracks inodes, so the child watcher would keep firing after a directory rename
    // but path.join(watchPath, filename) would use the stale original path. Watching the parent
    // catches the disappearance of watchPath and fires unlinkDir to clean up tracked files.
    const parentDir = path.dirname(watchPath);
    const watchedBasename = path.basename(watchPath);
    const parentWatcher = fs.watch(parentDir, async (eventType, filename) => {
      if (!ready || filename !== watchedBasename || eventType !== 'rename') return;
      try {
        await stat(watchPath);
        // Directory still exists — spurious event, ignore.
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
    for (const treePath of Object.keys(fsTree)) {
      if (treePath.startsWith(path)) delete fsTree[treePath];
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
