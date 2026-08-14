import path from 'node:path';
import { module, test } from 'qunitx';
import { scriptHint } from '../../../lib/commands/test.ts';
import '../../helpers/custom-asserts.ts';

// The hint a zero-test run prints is meant to be pasted straight back into a shell, so the one
// thing it must never do is echo a path in a shape the user did not type. `relativeTo` is
// injected for exactly this: `path.win32.relative` reproduces the Windows answer on any host,
// which is the only way to keep this covered from a POSIX CI lane.
module('Commands | run | scriptHint', { concurrency: true }, () => {
  test('renders a project-relative command on POSIX', (assert) => {
    assert.strictEqual(
      scriptHint('/proj', '/proj/scripts/seed.ts', path.posix.relative),
      'qunitx run scripts/seed.ts',
    );
  });

  test('renders forward slashes for a Windows host, not the native separator', (assert) => {
    assert.strictEqual(
      scriptHint('D:\\a\\proj', 'D:\\a\\proj\\test\\fixtures\\seed.ts', path.win32.relative),
      'qunitx run test/fixtures/seed.ts',
    );
  });

  test('keeps a Windows path that climbs out of the project pasteable', (assert) => {
    assert.strictEqual(
      scriptHint('D:\\a\\proj', 'D:\\a\\other\\seed.ts', path.win32.relative),
      'qunitx run ../other/seed.ts',
    );
  });

  test('leaves an absolute path alone when there is no relative route (other drive)', (assert) => {
    // path.relative across drive letters answers with the absolute target. It has no separator
    // to rewrite beyond the ones inside it, and the result is still a path the user can paste.
    assert.strictEqual(
      scriptHint('D:\\a\\proj', 'C:\\Temp\\seed.ts', path.win32.relative),
      'qunitx run C:/Temp/seed.ts',
    );
  });
});
