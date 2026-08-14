import path from 'node:path';
import { module, test } from 'qunitx';
import { realWatchDirectories, watchDirectoriesFrom } from '../../lib/commands/run.ts';
import '../helpers/custom-asserts.ts';

// Watch mode on Windows died on a script whose temp dir sat on another drive than the project:
// esbuild has no relative form for that, so it reports the input absolutely. `path.win32` is
// injected here to reproduce that answer from a POSIX lane.
module('Commands | script | watchDirectoriesFrom', { concurrency: true }, () => {
  test('resolves relative inputs against the working directory', (assert) => {
    assert.deepEqual(watchDirectoriesFrom(['scripts/seed.ts'], '/proj', path.posix), [
      '/proj/scripts',
    ]);
  });

  test('drops esbuild scaffolding and node_modules', (assert) => {
    const inputs = ['<stdin>', 'scripts/seed.ts', 'node_modules/left-pad/index.js'];
    assert.deepEqual(watchDirectoriesFrom(inputs, '/proj', path.posix), ['/proj/scripts']);
  });

  test('deduplicates directories shared by several inputs', (assert) => {
    const inputs = ['scripts/seed.ts', 'scripts/helper.ts'];
    assert.deepEqual(watchDirectoriesFrom(inputs, '/proj', path.posix), ['/proj/scripts']);
  });

  test('keeps an absolute Windows input on another drive than the project', (assert) => {
    // The regression: `C:/…` under a `D:\…` project. Resolving must yield the temp directory,
    // not a `D:\…\C:\…` splice, or the watcher watches a path that does not exist and the
    // script never re-runs.
    assert.deepEqual(
      watchDirectoriesFrom(
        ['C:/Users/RUNNER~1/AppData/Local/Temp/qx/watched.ts'],
        'D:\\a\\proj',
        path.win32,
      ),
      ['C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\qx'],
    );
  });

  test('resolves a relative Windows input against the project', (assert) => {
    assert.deepEqual(watchDirectoriesFrom(['test/seed.ts'], 'D:\\a\\proj', path.win32), [
      'D:\\a\\proj\\test',
    ]);
  });
});

// A watch registered on an 8.3 short name (`C:\Users\RUNNER~1\…`, which is what os.tmpdir()
// hands back on a GitHub Windows runner) receives events under the EXPANDED name. libuv prefix-
// compares the two and aborts the process when they disagree, so the CLI died mid-watch having
// printed nothing. Nothing else in the chain normalises the path — verified by watching through
// a symlink, the POSIX analogue, and seeing the alias spelling reach fs.watch untouched.
module('Commands | script | realWatchDirectories', { concurrency: true }, () => {
  test('expands each directory to its real path', async (assert) => {
    const expand = (directory: string) =>
      Promise.resolve(directory.replace('RUNNER~1', 'runneradmin'));

    assert.deepEqual(await realWatchDirectories(['C:\\Users\\RUNNER~1\\Temp\\qx'], expand), [
      'C:\\Users\\runneradmin\\Temp\\qx',
    ]);
  });

  test('collapses spellings that resolve to the same directory', async (assert) => {
    // The short and long forms of one directory must not become two watches on it.
    const expand = () => Promise.resolve('C:\\Users\\runneradmin\\Temp\\qx');
    const spellings = ['C:\\Users\\RUNNER~1\\Temp\\qx', 'C:\\Users\\runneradmin\\Temp\\qx'];

    assert.deepEqual(await realWatchDirectories(spellings, expand), [
      'C:\\Users\\runneradmin\\Temp\\qx',
    ]);
  });

  test('keeps a directory that will not resolve rather than dropping it', async (assert) => {
    const refuse = () => Promise.reject(new Error('ENOENT'));

    assert.deepEqual(await realWatchDirectories(['/gone'], refuse), ['/gone']);
  });

  test('resolves what it can when only one directory fails', async (assert) => {
    const expand = (directory: string) =>
      directory === '/bad'
        ? Promise.reject(new Error('ENOENT'))
        : Promise.resolve(`${directory}/real`);

    assert.deepEqual(await realWatchDirectories(['/good', '/bad'], expand), ['/good/real', '/bad']);
  });
});
