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
const FIXTURE_PASS_JS = 'test/fixtures/passing-tests.js';
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

  test('multi-file run uses concurrent groups inside the daemon', async (assert) => {
    await ensureDaemonStopped();
    await cli('daemon start');
    try {
      const result = await cli(`${FIXTURE_PASS} ${FIXTURE_PASS_JS}`);

      assert.exitCode(result, 0);
      // 2 files × 3 passing tests each = 6 total
      assert.includes(result, '# pass 6');
      assert.includes(result, '# fail 0');
      // The "(daemon)" tag rides on the same `# Running ...` line as group count.
      assert.regex(result, /# Running 2 test files across \d+ groups? \(daemon\)/);
      // Exactly one TAP header even though each group's web-server fires its own
      // 'connection' event — the suppress-in-daemon-mode check must hold.
      const headers = result.stdout.match(/^TAP version 13\b/gm) || [];
      assert.strictEqual(headers.length, 1, 'one TAP version header for the whole run');
    } finally {
      await ensureDaemonStopped();
    }
  });

  test('multi-file run with one failing file -> exit 1, fails counted', async (assert) => {
    await ensureDaemonStopped();
    await cli('daemon start');
    try {
      const result = await cli(`${FIXTURE_PASS} ${FIXTURE_FAIL}`, { failOk: true });

      assert.exitCode(result, 1);
      // Passing fixture contributes 3 passes, failing fixture has at least one fail.
      assert.regex(result, /# pass [3-9]/);
      assert.regex(result, /# fail [1-9]/);
      assert.includes(result, '(daemon)');
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

module('Commands | Daemon | auto-spawn', { concurrency: false }, () => {
  test('QUNITX_DAEMON=1 with no daemon -> auto-spawns and routes', async (assert) => {
    await ensureDaemonStopped();
    try {
      const result = await cli(FIXTURE_PASS, {
        env: { ...CLI_ENV, QUNITX_DAEMON: '1' },
      });

      assert.exitCode(result, 0);
      assert.includes(result, '# pass 3');
      assert.includes(result, '(daemon)');

      // Daemon must still be running for subsequent invocations to reuse.
      const status = await cli('daemon status');
      assert.exitCode(status, 0);
      assert.includes(status, 'Daemon running');
    } finally {
      await ensureDaemonStopped();
    }
  });

  test('without QUNITX_DAEMON, no daemon is spawned and run is local', async (assert) => {
    await ensureDaemonStopped();
    const result = await cli(FIXTURE_PASS);

    assert.exitCode(result, 0);
    assert.includes(result, '# pass 3');
    assert.notIncludes(result, '(daemon)');

    const status = await cli('daemon status', { failOk: true });
    assert.exitCode(status, 1);
    assert.includes(status, 'No daemon running');
  });

  test('QUNITX_DAEMON=1 with daemon already running -> reuses it', async (assert) => {
    await ensureDaemonStopped();
    await cli('daemon start');
    try {
      const startupPid = await readDaemonPid();

      const result = await cli(FIXTURE_PASS, {
        env: { ...CLI_ENV, QUNITX_DAEMON: '1' },
      });
      assert.exitCode(result, 0);
      assert.includes(result, '(daemon)');

      // Same daemon instance — no double-spawn.
      const samePid = await readDaemonPid();
      assert.strictEqual(samePid, startupPid, 'daemon process unchanged');
    } finally {
      await ensureDaemonStopped();
    }
  });

  test('QUNITX_DAEMON=1 + --no-daemon -> bypass wins, runs locally', async (assert) => {
    await ensureDaemonStopped();
    try {
      const result = await cli(`--no-daemon ${FIXTURE_PASS}`, {
        env: { ...CLI_ENV, QUNITX_DAEMON: '1' },
      });
      assert.exitCode(result, 0);
      assert.includes(result, '# pass 3');
      assert.notIncludes(result, '(daemon)');

      // No daemon spawned because --no-daemon vetoes auto-spawn.
      const status = await cli('daemon status', { failOk: true });
      assert.exitCode(status, 1);
    } finally {
      await ensureDaemonStopped();
    }
  });
});

module('Commands | Daemon | crash recovery', { concurrency: false }, () => {
  // Linux-only: relies on /proc/<pid>/task/<pid>/children to find the daemon's Chrome.
  // macOS/Windows lack a portable equivalent; the recovery code path itself is the same.
  const isLinux = process.platform === 'linux';

  test('daemon relaunches Chrome after it is SIGKILLed', async (assert) => {
    if (!isLinux) return assert.ok(true, 'skipped on non-linux');

    await ensureDaemonStopped();
    await cli('daemon start');
    try {
      const before = await cli(FIXTURE_PASS);
      assert.includes(before, '# pass 3');

      const daemonPid = await readDaemonPid();
      const killed = await killDaemonChrome(daemonPid);
      assert.ok(killed, "killed daemon's Chrome process");
      // Give Playwright's CDP transport a moment to flag the connection dead.
      await new Promise((r) => setTimeout(r, 200));

      const after = await cli(FIXTURE_PASS);
      assert.exitCode(after, 0);
      assert.includes(after, '# pass 3');
      assert.includes(after, '(daemon)');
    } finally {
      await ensureDaemonStopped();
    }
  });

  test('successful run resets the crash counter (consecutive crashes survive)', async (assert) => {
    if (!isLinux) return assert.ok(true, 'skipped on non-linux');

    // Two back-to-back kill+run cycles. If the counter were not reset by the successful
    // run between, the second cycle would push the daemon past MAX_CONSECUTIVE_CRASHES
    // and the third invocation (status check) would fail.
    await ensureDaemonStopped();
    await cli('daemon start');
    try {
      const startupPid = await readDaemonPid();

      // Cycle 1
      const cycle1Killed = await killDaemonChrome(startupPid);
      assert.ok(cycle1Killed, 'cycle 1: killed Chrome');
      await new Promise((r) => setTimeout(r, 200));
      const cycle1 = await cli(FIXTURE_PASS);
      assert.exitCode(cycle1, 0);
      assert.includes(cycle1, '# pass 3');

      // Cycle 2
      const cycle2Killed = await killDaemonChrome(startupPid);
      assert.ok(cycle2Killed, 'cycle 2: killed Chrome');
      await new Promise((r) => setTimeout(r, 200));
      const cycle2 = await cli(FIXTURE_PASS);
      assert.exitCode(cycle2, 0);
      assert.includes(cycle2, '# pass 3');

      // Daemon must still be the same process (not restarted, not dead).
      const status = await cli('daemon status');
      assert.exitCode(status, 0);
      const stillAlivePid = Number(/pid:\s+(\d+)/.exec(status.stdout)?.[1]);
      assert.strictEqual(stillAlivePid, startupPid, 'daemon process survived both crash cycles');
    } finally {
      await ensureDaemonStopped();
    }
  });

  test('post-run check recovers when Chrome dies during the run', async (assert) => {
    if (!isLinux) return assert.ok(true, 'skipped on non-linux');

    // Race condition: kill Chrome while a run is in flight. That run will fail (browser
    // mid-test died), but the daemon's post-run check must detect the disconnected
    // browser and relaunch so the *next* run succeeds.
    await ensureDaemonStopped();
    await cli('daemon start');
    try {
      await cli(FIXTURE_PASS); // warm-up: ensures daemon is ready

      const daemonPid = await readDaemonPid();
      // Schedule the kill ~150ms in. The fixture takes ~140ms; the kill almost always
      // lands while page.goto / WS handshake / first test is in flight.
      const killTimer = setTimeout(() => {
        void killDaemonChrome(daemonPid);
      }, 150);

      const inFlight = await cli(FIXTURE_PASS, { failOk: true });
      clearTimeout(killTimer);

      // The in-flight run may either complete (kill landed too late) or fail (kill
      // killed Chrome mid-run). Either is acceptable — what matters is that the next
      // run succeeds, proving the daemon recovered rather than getting stuck.
      assert.ok(
        inFlight.code === 0 || inFlight.code === 1,
        `in-flight run produced an exit code (got ${inFlight.code})`,
      );

      const next = await cli(FIXTURE_PASS);
      assert.exitCode(next, 0);
      assert.includes(next, '# pass 3');
      assert.includes(next, '(daemon)');
    } finally {
      await ensureDaemonStopped();
    }
  });
});

async function readDaemonPid(): Promise<number> {
  const status = await cli('daemon status');
  const pid = Number(/pid:\s+(\d+)/.exec(status.stdout)?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`daemon status did not report a valid pid:\n${status.stdout}`);
  }
  return pid;
}

/**
 * Kills only the daemon's direct Chrome child (filters by `chrome` in cmdline so the
 * esbuild service child stays alive). Returns true if at least one Chrome was killed.
 */
async function killDaemonChrome(daemonPid: number): Promise<boolean> {
  const childrenRaw = await fs
    .readFile(`/proc/${daemonPid}/task/${daemonPid}/children`, 'utf8')
    .catch(() => '');
  const childPids = childrenRaw.trim().split(/\s+/).filter(Boolean).map(Number);
  let killedAny = false;
  for (const pid of childPids) {
    const cmdline = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
    if (!/chrome/i.test(cmdline)) continue;
    try {
      process.kill(pid, 'SIGKILL');
      killedAny = true;
    } catch {
      /* already dead */
    }
  }
  return killedAny;
}
