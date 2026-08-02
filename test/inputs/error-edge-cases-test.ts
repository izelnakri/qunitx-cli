import { module, test } from 'qunitx';
import '../helpers/custom-asserts.ts';
import { shellFails } from '../helpers/shell.ts';

module('Inputs | unresolvable inputs', { concurrency: true }, (_hooks, moduleMetadata) => {
  // All three spellings land on the same code path: cli.ts has no "unknown command" handler,
  // so an unrecognised argument is just another input path, and a path that resolves to
  // nothing exits 1. One run per spelling proves the shared exit, and they go out together
  // so the file costs one browser slot's wall time rather than three.
  test('a missing file, a missing folder and an unrecognised argument all exit 1', async (assert, testMetadata) => {
    const metadata = { ...moduleMetadata, ...testMetadata };
    const [missingFile, missingFolder, unrecognised] = await Promise.all([
      // QUNITX_DEBUG so the failure message names which exit route ran. This assertion has
      // failed on Windows and macOS with the failure correctly reported and the code coming
      // out 0 — a combination none of cli.ts's exit routes can produce — and stderr is the
      // only channel that can say which one (or none) fired.
      shellFails('QUNITX_DEBUG=1 node cli.ts tmp/this-file-does-not-exist.js', metadata),
      shellFails('QUNITX_DEBUG=1 node cli.ts tmp/this-folder-does-not-exist', metadata),
      shellFails('QUNITX_DEBUG=1 node cli.ts this-command-does-not-exist', metadata),
    ]);

    assert.exitCode(missingFile, 1, 'a missing file exits 1');
    assert.exitCode(missingFolder, 1, 'a missing folder exits 1');
    assert.exitCode(unrecognised, 1, 'an unrecognised argument is a missing path, and exits 1');
  });
});
