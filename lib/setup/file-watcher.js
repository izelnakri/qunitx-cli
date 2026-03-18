import chokidar from 'chokidar';
import kleur from 'kleur';

/**
 * Starts chokidar watchers for each lookup path and calls `onEventFunc` on JS/TS file changes, debounced via a global flag.
 * @returns {object}
 */
export default function setupFileWatchers(testFileLookupPaths, config, onEventFunc, onFinishFunc) {
  const extensions = ['js', 'ts'];
  const fileWatchers = testFileLookupPaths.reduce((watcher, watchPath) => {
    return Object.assign(watcher, {
      [watchPath]: chokidar
        .watch(watchPath, { ignoreInitial: true })
        .on('all', (event, filePath) =>
          handleWatchEvent(config, extensions, event, filePath, onEventFunc, onFinishFunc),
        ),
    });
  }, {});

  return {
    fileWatchers,
    killFileWatchers() {
      Object.keys(fileWatchers).forEach((watcherKey) => fileWatchers[watcherKey].close());

      return fileWatchers;
    },
  };
}

/**
 * Routes a chokidar event to fsTree mutation and optional rebuild trigger.
 * `unlinkDir` bypasses the extension filter so deleted directories always clean up fsTree.
 * @returns {void}
 */
export function handleWatchEvent(config, extensions, event, filePath, onEventFunc, onFinishFunc) {
  const isFileEvent = extensions.some((ext) => filePath.endsWith(ext));

  if (!isFileEvent && event !== 'unlinkDir') return;

  mutateFSTree(config.fsTree, event, filePath);

  console.log(
    '#',
    kleur.magenta().bold('=================================================================='),
  );
  console.log('#', getEventColor(event), filePath.split(config.projectRoot)[1]);
  console.log(
    '#',
    kleur.magenta().bold('=================================================================='),
  );

  if (!global.chokidarBuild) {
    global.chokidarBuild = true;

    const result = onEventFunc(event, filePath);

    if (!(result instanceof Promise)) {
      global.chokidarBuild = false;

      return result;
    }

    result
      .then(() => {
        onFinishFunc ? onFinishFunc(event, filePath) : null;
      })
      .catch(() => {
        // TODO: make an index.html to display the error
        // error type has to be derived from the error!
      })
      .finally(() => (global.chokidarBuild = false));
  }
}

/**
 * Mutates `fsTree` in place based on a chokidar file-system event.
 * @returns {void}
 */
export function mutateFSTree(fsTree, event, path) {
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

function getEventColor(event) {
  if (event === 'change') {
    return kleur.yellow('CHANGED:');
  } else if (event === 'add' || event === 'addDir') {
    return kleur.green('ADDED:');
  } else if (event === 'unlink' || event === 'unlinkDir') {
    return kleur.red('REMOVED:');
  }
}
