import { module, test } from 'qunitx';
import os from 'node:os';
import path from 'node:path';
import { daemonSocketPath, daemonInfoPath } from '../../lib/utils/daemon-socket-path.ts';
import '../helpers/custom-asserts.ts';

const FIXED_CWD = '/some/test/project';

module('Utils | daemonSocketPath', { concurrency: true }, () => {
  test('linux: places the socket under os.tmpdir() with .sock suffix', (assert) => {
    const result = daemonSocketPath(FIXED_CWD, 'linux');
    assert.equal(path.dirname(result), os.tmpdir());
    assert.regex(path.basename(result), /^qunitx-daemon-[0-9a-f]{12}\.sock$/);
  });

  test('darwin: places the socket under os.tmpdir() with .sock suffix', (assert) => {
    const result = daemonSocketPath(FIXED_CWD, 'darwin');
    assert.equal(path.dirname(result), os.tmpdir());
    assert.regex(path.basename(result), /^qunitx-daemon-[0-9a-f]{12}\.sock$/);
  });

  test('win32: emits a \\\\.\\pipe\\ named-pipe path (no .sock suffix)', (assert) => {
    const result = daemonSocketPath(FIXED_CWD, 'win32');
    // node:net on Windows requires named pipes to live in \\.\pipe\ (or \\?\pipe\).
    assert.regex(result, /^\\\\\.\\pipe\\qunitx-daemon-[0-9a-f]{12}$/);
  });

  test('same cwd → same path on the same platform (deterministic)', (assert) => {
    assert.equal(daemonSocketPath(FIXED_CWD, 'linux'), daemonSocketPath(FIXED_CWD, 'linux'));
    assert.equal(daemonSocketPath(FIXED_CWD, 'win32'), daemonSocketPath(FIXED_CWD, 'win32'));
  });

  test('different cwds → different paths on the same platform', (assert) => {
    assert.notEqual(
      daemonSocketPath('/project/a', 'linux'),
      daemonSocketPath('/project/b', 'linux'),
    );
    assert.notEqual(
      daemonSocketPath('/project/a', 'win32'),
      daemonSocketPath('/project/b', 'win32'),
    );
  });
});

module('Utils | daemonInfoPath', { concurrency: true }, () => {
  test('always under os.tmpdir() with .json suffix (regardless of platform)', (assert) => {
    // The info file is the cross-platform presence sentinel — it must always live on
    // the regular filesystem so existsSync() can see it on Windows too.
    const result = daemonInfoPath(FIXED_CWD);
    assert.equal(path.dirname(result), os.tmpdir());
    assert.regex(path.basename(result), /^qunitx-daemon-[0-9a-f]{12}\.json$/);
  });

  test('shares the cwd hash with daemonSocketPath (same project → paired files)', (assert) => {
    const sock = daemonSocketPath(FIXED_CWD, 'linux');
    const info = daemonInfoPath(FIXED_CWD);
    const sockHash = /-([0-9a-f]{12})\.sock$/.exec(sock)?.[1];
    const infoHash = /-([0-9a-f]{12})\.json$/.exec(info)?.[1];
    assert.ok(sockHash && infoHash, 'both paths carry a hash');
    assert.equal(sockHash, infoHash);
  });
});
