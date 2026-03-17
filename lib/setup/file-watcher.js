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
      [watchPath]: chokidar.watch(watchPath, { ignoreInitial: true }).on('all', (event, path) => {
        if (extensions.some((extension) => path.endsWith(extension))) {
          mutateFSTree(config.fsTree, event, path);

          console.log(
            '#',
            kleur
              .magenta()
              .bold('=================================================================='),
          );
          console.log('#', getEventColor(event), path.split(config.projectRoot)[1]);
          console.log(
            '#',
            kleur
              .magenta()
              .bold('=================================================================='),
          );

          if (!global.chokidarBuild) {
            global.chokidarBuild = true;

            const result = extensions.some((extension) => path.endsWith(extension))
              ? onEventFunc(event, path)
              : null;

            if (!(result instanceof Promise)) {
              global.chokidarBuild = false;

              return result;
            }

            result
              .then(() => {
                onFinishFunc ? onFinishFunc(event, path) : null;
              })
              .catch(() => {
                // TODO: make an index.html to display the error
                // error type has to be derived from the error!
              })
              .finally(() => (global.chokidarBuild = false));
          }
        }
      }),
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
