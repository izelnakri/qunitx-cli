import { module, test } from 'qunitx';
import process from 'node:process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { exec } from 'node:child_process';
import { daemonSocketPath, daemonInfoPath } from '../../lib/utils/daemon-socket-path.ts';
import '../helpers/custom-asserts.ts';

const CWD = process.cwd();
const shellExec = promisify(exec);

// Each daemon test removes QUNITX_NO_DAEMON from the env so its own `node cli.ts <test>`
// invocations actually route through the daemon. The runner sets QUNITX_NO_DAEMON=1
// globally so other test files don't accidentally route through this test's daemon
// while it's alive (the socket path is per-cwd and there is one project cwd in the suite).
const CLI_ENV = (() => {
  const env = { ...process.env, FORCE_COLOR: '0' };
  delete env.QUNITX_NO_DAEMON;
  return env;
})();

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

const cli = (
  args: string,
  opts: { failOk?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<CliResult> =>
  shellExec(`node ${CWD}/cli.ts ${args}`, { env: opts.env ?? CLI_ENV }).then(
    ({ stdout, stderr }) => ({ stdout, stderr, code: 0 }),
    (err: NodeJS.ErrnoException & { stdout: string; stderr: string }) => {
      if (opts.failOk)
        return { stdout: err.stdout, stderr: err.stderr, code: err.code as unknown as number };
      throw err;
    },
  );

const SOCKET_PATH = daemonSocketPath(CWD);
const INFO_PATH = daemonInfoPath(CWD);

async function ensureDaemonStopped(): Promise<void> {
  // Best-effort cleanup — tolerates a missing daemon (`stop` is idempotent).
  await cli('daemon stop').catch(() => {});
  // Defensive: drop a stale socket file that a crashed daemon may have left behind.
  await fs.unlink(SOCKET_PATH).catch(() => {});
  await fs.unlink(INFO_PATH).catch(() => {});
}

const FIXTURE_PASS = 'test/fixtures/passing-tests.ts';
const FIXTURE_FAIL = 'test/fixtures/failing-tests.ts';

// Daemon tests must run serially: they share a single per-cwd socket path. Concurrent
// tests would step on each other's daemon state.
module('Commands | Daemon | usage', { concurrency: false }, () => {
  test('$ qunitx daemon -> prints usage and exits 0', async (assert) => {
    const result = await cli('daemon');

    assert.exitCode(result, 0);
    const text = result.stdout + result.stderr;
    assert.includes(text, 'Usage: qunitx daemon');
    assert.includes(text, 'start');
    assert.includes(text, 'stop');
    assert.includes(text, 'status');
  });

  test('$ qunitx daemon foobar -> prints usage and exits 1', async (assert) => {
    const result = await cli('daemon foobar', { failOk: true });

    assert.exitCode(result, 1);
    assert.includes(result.stderr, 'Usage: qunitx daemon');
  });
});

module('Commands | Daemon | lifecycle', { concurrency: false }, () => {
  test('status with no daemon running -> exit 1, "No daemon running"', async (assert) => {
    await ensureDaemonStopped();
    const result = await cli('daemon status', { failOk: true });

    assert.exitCode(result, 1);
    assert.includes(result, 'No daemon running');
  });

  test('stop with no daemon running -> exit 0, "No daemon was running"', async (assert) => {
    await ensureDaemonStopped();
    const result = await cli('daemon stop');

    assert.exitCode(result, 0);
    assert.includes(result, 'No daemon was running');
  });

  test('start -> exit 0, "Daemon started", socket + info files exist', async (assert) => {
    await ensureDaemonStopped();
    try {
      const result = await cli('daemon start');

      assert.exitCode(result, 0);
      assert.includes(result, 'Daemon started');
      assert.regex(result, /pid \d+/);
      assert.ok(existsSync(SOCKET_PATH), 'socket file exists');
      assert.ok(existsSync(INFO_PATH), 'info file exists');
    } finally {
      await ensureDaemonStopped();
    }
  });

  test('status with daemon running -> exit 0 with full details', async (assert) => {
    await ensureDaemonStopped();
    await cli('daemon start');
    try {
      const result = await cli('daemon status');

      assert.exitCode(result, 0);
      assert.includes(result, 'Daemon running');
      assert.regex(result, /pid:\s+\d+/);
      assert.includes(result, `cwd:     ${CWD}`);
      assert.regex(result, /node:\s+v\d+/);
      assert.includes(result, `socket:  ${SOCKET_PATH}`);
    } finally {
      await ensureDaemonStopped();
    }
  });

  test('start when already running -> exit 0, "already running"', async (assert) => {
    await ensureDaemonStopped();
    await cli('daemon start');
    try {
      const result = await cli('daemon start');

      assert.exitCode(result, 0);
      assert.includes(result, 'already running');
      assert.regex(result, /pid \d+/);
    } finally {
      await ensureDaemonStopped();
    }
  });

  test('stop while running -> exit 0, removes socket + info files', async (assert) => {
    await ensureDaemonStopped();
    await cli('daemon start');
    assert.ok(existsSync(SOCKET_PATH), 'socket exists pre-stop');

    const result = await cli('daemon stop');

    assert.exitCode(result, 0);
    assert.includes(result, 'Daemon stopped');
    assert.notOk(existsSync(SOCKET_PATH), 'socket file removed');
    assert.notOk(existsSync(INFO_PATH), 'info file removed');
  });

  test('start cleans up a stale socket file from a crashed daemon', async (assert) => {
    await ensureDaemonStopped();
    // Simulate a stale socket from a crashed daemon — file exists but no listener.
    // The daemon's `isLiveSocket` probe returns false; it `unlink`s and re-listens.
    await fs.writeFile(SOCKET_PATH, '');
    assert.ok(existsSync(SOCKET_PATH), 'stale socket file present pre-start');

    try {
      const result = await cli('daemon start');

      assert.exitCode(result, 0);
      assert.includes(result, 'Daemon started');
      const stats = await fs.stat(SOCKET_PATH);
      assert.ok(stats.isSocket(), 'socket file is a live socket post-start');
    } finally {
      await ensureDaemonStopped();
    }
  });
});

module('Commands | Daemon | run routing', { concurrency: false }, () => {
  test('passing test through daemon -> exit 0 and TAP marks "(daemon)"', async (assert) => {
    await ensureDaemonStopped();
    await cli('daemon start');
    try {
      const result = await cli(FIXTURE_PASS);

      assert.exitCode(result, 0);
      assert.includes(result, 'TAP version 13');
      assert.includes(result, '(daemon)');
      assert.includes(result, '# pass 3');
      assert.includes(result, '# fail 0');
    } finally {
      await ensureDaemonStopped();
    }
  });

  test('failing test through daemon -> exit 1, TAP shows failures', async (assert) => {
    await ensureDaemonStopped();
    await cli('daemon start');
    try {
      const result = await cli(FIXTURE_FAIL, { failOk: true });

      assert.exitCode(result, 1);
      assert.includes(result, '(daemon)');
      assert.regex(result, /# fail [1-9]/);
    } finally {
      await ensureDaemonStopped();
    }
  });

  test('two consecutive daemon-routed runs both succeed (warm context reuse)', async (assert) => {
    await ensureDaemonStopped();
    await cli('daemon start');
    try {
      const r1 = await cli(FIXTURE_PASS);
      const r2 = await cli(FIXTURE_PASS);

      assert.exitCode(r1, 0);
      assert.exitCode(r2, 0);
      assert.includes(r1, '# pass 3');
      assert.includes(r2, '# pass 3');
      assert.includes(r1, '(daemon)');
      assert.includes(r2, '(daemon)');
    } finally {
      await ensureDaemonStopped();
    }
  });

  test('TAP version 13 header appears exactly once per daemon-routed run', async (assert) => {
    await ensureDaemonStopped();
    await cli('daemon start');
    try {
      const result = await cli(FIXTURE_PASS);
      const matches = result.stdout.match(/^TAP version 13\b/gm) || [];

      assert.strictEqual(
        matches.length,
        1,
        `expected exactly one TAP version header, got ${matches.length}`,
      );
    } finally {
      await ensureDaemonStopped();
    }
  });
});

module('Commands | Daemon | bypass', { concurrency: false }, () => {
  test('--no-daemon bypasses a running daemon (no "(daemon)" suffix)', async (assert) => {
    await ensureDaemonStopped();
    await cli('daemon start');
    try {
      const result = await cli(`--no-daemon ${FIXTURE_PASS}`);

      assert.exitCode(result, 0);
      assert.includes(result, '# pass 3');
      assert.notIncludes(result, '(daemon)');
    } finally {
      await ensureDaemonStopped();
    }
  });

  test('QUNITX_NO_DAEMON env var bypasses a running daemon', async (assert) => {
    await ensureDaemonStopped();
    await cli('daemon start');
    try {
      const result = await cli(FIXTURE_PASS, {
        env: { ...CLI_ENV, QUNITX_NO_DAEMON: '1' },
      });

      assert.exitCode(result, 0);
      assert.includes(result, '# pass 3');
      assert.notIncludes(result, '(daemon)');
    } finally {
      await ensureDaemonStopped();
    }
  });

  test('CI env var bypasses a running daemon', async (assert) => {
    await ensureDaemonStopped();
    await cli('daemon start');
    try {
      const result = await cli(FIXTURE_PASS, { env: { ...CLI_ENV, CI: '1' } });

      assert.exitCode(result, 0);
      assert.includes(result, '# pass 3');
      assert.notIncludes(result, '(daemon)');
    } finally {
      await ensureDaemonStopped();
    }
  });
});
