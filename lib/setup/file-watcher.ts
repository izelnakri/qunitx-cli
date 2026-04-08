import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { green, magenta, red, yellow } from '../utils/color.ts';
import type { FSWatcher } from 'node:fs';
import type { Config, FSTree } from '../types.ts';

/**
 * Starts `fs.watch` watchers for each lookup path and calls `onEventFunc` on JS/TS file changes, debounced via a flag.
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
  const fileWatchers = testFileLookupPaths.reduce((watchers, watchPath) => {
    let ready = false;
    const watcher = fs.watch(watchPath, { recursive: true }, async (eventType, filename) => {
      if (!ready || !filename) return;
      const fullPath = path.join(watchPath, filename);
      if (eventType === 'change') {
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
        const event = config.fsTree && fullPath in config.fsTree ? 'unlink' : 'unlinkDir';
        handleWatchEvent(config, extensions, event, fullPath, onEventFunc, onFinishFunc);
      }
    });
    readyPromises.push(
      new Promise<void>((resolve) =>
        setImmediate(() => {
          ready = true;
          resolve();
        }),
      ),
    );
    return Object.assign(watchers, { [watchPath]: watcher });
  }, {});

  return {
    fileWatchers,
    ready: Promise.all(readyPromises).then(() => {}),
    killFileWatchers() {
      Object.keys(fileWatchers).forEach((watcherKey) => fileWatchers[watcherKey].close());

      return fileWatchers;
    },
  };
}

/**
 * Routes a file-system event to fsTree mutation and optional rebuild trigger.
 * `unlinkDir` bypasses the extension filter so deleted directories always clean up fsTree.
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
      .finally(() => (config._building = false));
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
