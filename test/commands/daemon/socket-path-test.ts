import { module, test } from 'qunitx';
import os from 'node:os';
import path from 'node:path';
import {
  daemonSocketPath,
  daemonInfoPath,
  daemonDir,
} from '../../../lib/commands/daemon/socket-path.ts';
import '../../helpers/custom-asserts.ts';

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
  test('lives inside a per-cwd subdirectory under os.tmpdir() with info.json filename', (assert) => {
    // The info file is the cross-platform presence sentinel — it must always live on
    // the regular filesystem so existsSync() can see it on Windows too.
    const result = daemonInfoPath(FIXED_CWD);
    const dir = path.dirname(result);
    assert.equal(path.dirname(dir), os.tmpdir(), 'parent dir is a child of os.tmpdir');
    assert.regex(path.basename(dir), /^qunitx-daemon-[0-9a-f]{12}$/);
    assert.equal(path.basename(result), 'info.json');
  });

  test('NOT directly under os.tmpdir() — required to avoid the Windows libuv fs.watch assert', (assert) => {
    // Regression guard for the libuv assertion crash:
    //   Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c, line 72
    // The client's waitForFile (lib/commands/daemon/index.ts) calls
    // fs.watch(path.dirname(daemonInfoPath())) to detect daemon readiness.
    // On Windows, watching os.tmpdir() directly crashes the watcher process
    // (exit code 3221226505 / STATUS_STACK_BUFFER_OVERRUN) under parallel test
    // load — unrelated file events on the temp root produce absolute paths
    // that don't case-insensitively match the watched prefix and libuv
    // asserts. Reproduced on test (windows-latest) in CI run 26552908498.
    // Putting the info file under a per-cwd subdirectory means the watcher
    // only sees events from files this daemon owns.
    assert.notEqual(
      path.dirname(daemonInfoPath(FIXED_CWD)),
      os.tmpdir(),
      'info file must live in a subdirectory, not directly under os.tmpdir()',
    );
  });

  test('daemonDir() returns the same parent as daemonInfoPath dirname', (assert) => {
    assert.equal(daemonDir(FIXED_CWD), path.dirname(daemonInfoPath(FIXED_CWD)));
  });

  test('shares the cwd hash with daemonSocketPath (same project → paired files)', (assert) => {
    const sock = daemonSocketPath(FIXED_CWD, 'linux');
    const info = daemonInfoPath(FIXED_CWD);
    const sockHash = /-([0-9a-f]{12})\.sock$/.exec(sock)?.[1];
    // Match either separator: POSIX joins with '/', Windows with '\'.
    const infoHash = /-([0-9a-f]{12})[/\\]/.exec(info)?.[1];
    assert.ok(sockHash && infoHash, 'both paths carry a hash');
    assert.equal(sockHash, infoHash);
  });

  test('different cwds → different daemon directories', (assert) => {
    assert.notEqual(daemonDir('/project/a'), daemonDir('/project/b'));
  });
});
