import { module, test } from 'qunitx';
import process from 'node:process';
import fs from 'node:fs/promises';
import nodeFs, { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { daemonSocketPath, daemonInfoPath } from '../../lib/utils/daemon-socket-path.ts';
import { shutdownDaemon } from '../../lib/commands/daemon/client.ts';
import { spawnCapture, type CapturedError, type CapturedResult } from '../helpers/shell.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';
import '../helpers/custom-asserts.ts';

const CWD = process.cwd();
const FIXTURE_PASS = path.resolve('test/fixtures/passing-tests.ts');
const FIXTURE_PASS_JS = path.resolve('test/fixtures/passing-tests.js');
const FIXTURE_FAIL = path.resolve('test/fixtures/failing-tests.ts');

// Strip every env var that would cause `shouldUseDaemon` or `shouldAutoSpawnDaemon`
// to short-circuit, so this file's `node cli.ts <test>` invocations actually route
// through the daemon. The runner sets QUNITX_NO_DAEMON=1 globally; GitHub Actions sets
// CI=true. Both short-circuit the daemon dispatch and would silently turn every daemon
// test into a local run, dropping the "(daemon)" marker that several assertions rely on.
// Bypass tests below explicitly re-add CI / QUNITX_NO_DAEMON / --no-daemon to verify
// they win over the daemon path.
const CLI_ENV = (() => {
  const env = { ...process.env, FORCE_COLOR: '0' };
  delete env.QUNITX_NO_DAEMON;
  delete env.CI;
  return env;
})();

interface DaemonProject {
  cwd: string;
  socketPath: string;
  infoPath: string;
}

/**
 * Creates a unique tmp/<uuid>/ working directory for one daemon test. Each project
 * gets its own cwd → its own socketPath/infoPath, so tests can run with concurrency:
 * true without stepping on each other's daemon state. node_modules is symlinked
 * from the project root so qunitx and dev deps resolve when the daemon bundles
 * fixtures at run time.
 */
async function makeDaemonProject(): Promise<DaemonProject> {
  const id = randomUUID();
  const cwd = path.join(CWD, 'tmp', `daemon-${id}`);
  await fs.mkdir(cwd, { recursive: true });
  await Promise.all([
    fs.symlink(path.join(CWD, 'node_modules'), path.join(cwd, 'node_modules')),
    fs.writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: id, version: '0.0.1', type: 'module' }),
    ),
  ]);
  return { cwd, socketPath: daemonSocketPath(cwd), infoPath: daemonInfoPath(cwd) };
}

// Spawn via shared helper so QUNITX_BIN is honored: when scripts/test-release.sh sets
// it to the installed binary (or the SEA blob), every daemon invocation here actually
// exercises the published artefact instead of source. The previous local exec() helper
// hardcoded `node cli.ts` and silently bypassed the swap, so daemon-specific bugs in
// any released binary slipped past the consumer test.
const cli = async (
  project: DaemonProject,
  args: string,
  opts: { failOk?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<CapturedResult> => {
  try {
    return await spawnCapture(`node ${CWD}/cli.ts ${args}`, {
      env: opts.env ?? CLI_ENV,
      cwd: project.cwd,
    });
  } catch (err) {
    if (opts.failOk) return err as CapturedError;
    throw err;
  }
};

async function ensureDaemonStopped(project: DaemonProject): Promise<void> {
  // Cleanup helper: call the lib's shutdownDaemon directly instead of spawning
  // `node cli.ts daemon stop`. Saves ~600 ms per call (cli.ts compile + Node
  // startup) × ~60 calls per suite. The CLI stop path is exercised explicitly
  // by the lifecycle tests below, so we don't need to re-cover it here.
  // shutdownDaemon reads the pid, sends shutdown via socket, waits for pid exit;
  // it returns false (no throw) when no daemon is running.
  await shutdownDaemon(project.cwd).catch(() => {});
  // Defensive: drop stale files that a crashed daemon may have left behind
  // (e.g. SIGKILL'd before the shutdown handler could unlink them).
  await Promise.all([
    fs.unlink(project.socketPath).catch(() => {}),
    fs.unlink(project.infoPath).catch(() => {}),
  ]);
}

/**
 * Resolves `true` once `filePath` no longer exists, or `false` on timeout.
 * Event-driven: subscribes to `fs.watch` on the parent directory and reacts to the
 * kernel's unlink notification (sub-ms latency, zero CPU between events). Inverse
 * of `waitForFile` in `lib/commands/daemon/index.ts`. The two `existsSync` checks
 * bracket the watcher attachment to close the TOCTOU gap — the file may disappear
 * between the entry-point check and the kernel watch becoming active.
 */
function waitForFileGone(filePath: string, timeoutMs: number): Promise<boolean> {
  if (!existsSync(filePath)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const dir = path.dirname(filePath);
    const fileName = path.basename(filePath);
    const settle = (gone: boolean) => {
      clearTimeout(timer);
      watcher.close();
      resolve(gone);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    const watcher = nodeFs.watch(dir, (_event, name) => {
      if (name === fileName && !existsSync(filePath)) settle(true);
    });
    watcher.on('error', () => settle(false));
    if (!existsSync(filePath)) settle(true);
  });
}

/**
 * Wraps a daemon test in (a) per-test project setup, (b) browser-semaphore acquisition
 * for tests that actually spawn a daemon (most do — the daemon launches Chrome on start),
 * and (c) ensureDaemonStopped cleanup on exit. Module-level concurrency:true means many
 * tests fire at once — the semaphore caps the number of live daemon-Chromes at the same
 * availableParallelism() ceiling that bounds the rest of the suite, so daemon tests share
 * one global resource budget with folder-test/jsx-test instead of overrunning the box.
 */
function daemonTest(
  name: string,
  fn: (assert: Parameters<Parameters<typeof test>[1]>[0], project: DaemonProject) => Promise<void>,
): void {
  test(name, async (assert) => {
    const project = await makeDaemonProject();
    const permit = await acquireBrowser();
    try {
      await fn(assert, project);
    } finally {
      await ensureDaemonStopped(project).catch(() => {});
      permit.release();
    }
  });
}

// "usage" tests don't spawn a daemon — they only test cli subcommand parsing.
// They get a project for the cwd but don't acquire a browser permit.
function daemonUsageTest(
  name: string,
  fn: (assert: Parameters<Parameters<typeof test>[1]>[0], project: DaemonProject) => Promise<void>,
): void {
  test(name, async (assert) => {
    const project = await makeDaemonProject();
    await fn(assert, project);
  });
}

// Each test now runs in its own per-uuid cwd, so `concurrency: true` is safe — daemon
// state is isolated per test. The browser semaphore caps the actual chromes-at-once
// across the whole suite at availableParallelism(), so 32 daemon tests don't all fire
// at full saturation regardless of node:test's concurrency model.
module('Commands | Daemon | usage', { concurrency: true }, () => {
  daemonUsageTest('$ qunitx daemon -> prints usage and exits 0', async (assert, project) => {
    const result = await cli(project, 'daemon');

    assert.exitCode(result, 0);
    const text = result.stdout + result.stderr;
    assert.includes(text, 'Usage: qunitx daemon');
    assert.includes(text, 'start');
    assert.includes(text, 'stop');
    assert.includes(text, 'status');
  });

  daemonUsageTest('$ qunitx daemon foobar -> prints usage and exits 1', async (assert, project) => {
    const result = await cli(project, 'daemon foobar', { failOk: true });

    assert.exitCode(result, 1);
    assert.includes(result.stderr, 'Usage: qunitx daemon');
  });

  daemonUsageTest(
    '$ qunitx daemon --help / -h / help -> usage on stdout, exits 0',
    async (assert, project) => {
      for (const flag of ['--help', '-h', 'help']) {
        const result = await cli(project, `daemon ${flag}`);
        assert.exitCode(result, 0, `daemon ${flag} exits 0`);
        assert.includes(
          result.stdout,
          'Usage: qunitx daemon',
          `daemon ${flag} prints usage to stdout`,
        );
        assert.includes(
          result.stdout,
          'QUNITX_DAEMON=1',
          `daemon ${flag} mentions auto-spawn env var`,
        );
      }
    },
  );
});

module('Commands | Daemon | lifecycle', { concurrency: true }, () => {
  daemonTest(
    'status with no daemon running -> exit 1, "No daemon running"',
    async (assert, project) => {
      const result = await cli(project, 'daemon status', { failOk: true });

      assert.exitCode(result, 1);
      assert.includes(result, 'No daemon running');
    },
  );

  daemonTest(
    'stop with no daemon running -> exit 0, "No daemon was running"',
    async (assert, project) => {
      const result = await cli(project, 'daemon stop');

      assert.exitCode(result, 0);
      assert.includes(result, 'No daemon was running');
    },
  );

  daemonTest('start -> exit 0, "Daemon started", info file exists', async (assert, project) => {
    const result = await cli(project, 'daemon start');

    assert.exitCode(result, 0);
    assert.includes(result, 'Daemon started');
    assert.regex(result, /pid \d+/);
    // Info file is the cross-platform presence sentinel — on Windows the socket is
    // a named pipe and existsSync(socketPath) cannot see it.
    assert.ok(existsSync(project.infoPath), 'info file exists');
  });

  daemonTest('status with daemon running -> exit 0 with full details', async (assert, project) => {
    await cli(project, 'daemon start');
    const result = await cli(project, 'daemon status');

    assert.exitCode(result, 0);
    assert.includes(result, 'Daemon running');
    assert.regex(result, /pid:\s+\d+/);
    assert.includes(result, `cwd:     ${project.cwd}`);
    assert.regex(result, /node:\s+v\d+/);
    assert.includes(result, `socket:  ${project.socketPath}`);
  });

  daemonTest('start when already running -> exit 0, "already running"', async (assert, project) => {
    await cli(project, 'daemon start');
    const result = await cli(project, 'daemon start');

    assert.exitCode(result, 0);
    assert.includes(result, 'already running');
    assert.regex(result, /pid \d+/);
  });

  daemonTest('stop while running -> exit 0, removes info file', async (assert, project) => {
    await cli(project, 'daemon start');
    assert.ok(existsSync(project.infoPath), 'info file exists pre-stop');

    const result = await cli(project, 'daemon stop');

    assert.exitCode(result, 0);
    assert.includes(result, 'Daemon stopped');
    assert.notOk(existsSync(project.infoPath), 'info file removed');
    // Socket is a named pipe on Windows (no fs entry) — only assert on POSIX.
    if (process.platform !== 'win32') {
      assert.notOk(existsSync(project.socketPath), 'socket file removed');
    }
  });

  daemonTest(
    'rapid stop+start cycles do not race the daemon resource teardown',
    async (assert, project) => {
      // Regression test: the dispatch handler used to ack 'done' to the client BEFORE
      // the daemon's async cleanup (server.close, browser.close, process.exit) ran.
      // A fast follow-up `daemon start` could race the dying daemon's socket/named-
      // pipe handle and hit EADDRINUSE — the new daemon exited, the parent timed out
      // polling for the info file, and the cli reported "Daemon did not start within
      // 10s". Especially reliable on Windows where named-pipe handle release lags
      // process exit. Three cycles back-to-back makes the race detectable on any
      // platform if the wait-for-pid-exit fix in client.ts ever regresses.
      for (let i = 0; i < 3; i++) {
        const start = await cli(project, 'daemon start');
        assert.exitCode(start, 0, `iteration ${i}: start succeeded`);
        const stop = await cli(project, 'daemon stop');
        assert.exitCode(stop, 0, `iteration ${i}: stop succeeded`);
      }
    },
  );

  daemonTest(
    'concurrent daemon start invocations converge on a single live daemon',
    async (assert, project) => {
      // Two simultaneous starts exercise THREE invariants in one test:
      //
      // 1. Atomic claim: listen() is the only at-most-one operation; whichever
      //    process binds first wins. The loser hits EADDRINUSE.
      // 2. Listen-failure cleanup correctness: the loser's shutdown must NOT unlink
      //    the winner's socket/info files. Without the `listenSucceeded` gate this
      //    silently corrupts the winner — info file vanishes, POSIX socket dirent
      //    is removed, the running daemon becomes unreachable to new clients while
      //    its own fds keep working. Catastrophic and silent.
      // 3. Convergent client view: both clients' polls — which require BOTH info
      //    file presence AND a live ping — must report the SAME surviving daemon's
      //    pid. A pid mismatch would mean one client returned during a brief
      //    inconsistent window.
      //
      // The single-iteration "info file exists at start return" lifecycle test
      // covers the basic startup contract. This test is the strictly stronger
      // regression — it would catch every race the lifecycle test catches, plus
      // listen-failure corruption that single-process tests can't reach.
      const [r1, r2] = await Promise.all([
        cli(project, 'daemon start'),
        cli(project, 'daemon start'),
      ]);

      assert.exitCode(r1, 0, 'first start exited 0');
      assert.exitCode(r2, 0, 'second start exited 0');

      // Both "Daemon started (pid N)" and "Daemon already running (pid N)" carry
      // the surviving pid; either match shape is acceptable.
      const pid1 = Number(/pid (\d+)/.exec(r1.stdout)?.[1]);
      const pid2 = Number(/pid (\d+)/.exec(r2.stdout)?.[1]);
      assert.ok(Number.isInteger(pid1) && pid1 > 0, `client 1 reported pid (got ${pid1})`);
      assert.ok(Number.isInteger(pid2) && pid2 > 0, `client 2 reported pid (got ${pid2})`);
      assert.equal(pid1, pid2, 'both clients converge on the same surviving daemon pid');

      // Loser's listen-failure path must NOT have unlinked the winner's files.
      assert.ok(existsSync(project.infoPath), 'winner info file intact after concurrent race');

      const status = await cli(project, 'daemon status');
      assert.exitCode(status, 0);
      const statusPid = Number(/pid:\s+(\d+)/.exec(status.stdout)?.[1]);
      assert.equal(statusPid, pid1, 'status reports the surviving daemon pid');
    },
  );

  daemonTest(
    'start cleans up a stale socket file from a crashed daemon',
    async (assert, project) => {
      // POSIX-only: simulating a stale socket requires writing a regular file at the
      // socket path. Windows sockets are named pipes (\\.\pipe\...) — fs.writeFile to
      // that path is not a valid operation, and stale named pipes auto-recycle anyway.
      if (process.platform === 'win32') return assert.ok(true, 'skipped on win32');

      // Simulate a stale socket from a crashed daemon — file exists but no listener.
      // The daemon's `isLiveSocket` probe returns false; it `unlink`s and re-listens.
      await fs.writeFile(project.socketPath, '');
      assert.ok(existsSync(project.socketPath), 'stale socket file present pre-start');

      const result = await cli(project, 'daemon start');

      assert.exitCode(result, 0);
      assert.includes(result, 'Daemon started');
      const stats = await fs.stat(project.socketPath);
      assert.ok(stats.isSocket(), 'socket file is a live socket post-start');
    },
  );
});

module('Commands | Daemon | run routing', { concurrency: true }, () => {
  daemonTest(
    'passing test through daemon -> exit 0 and TAP marks "(daemon)"',
    async (assert, project) => {
      await cli(project, 'daemon start');
      const result = await cli(project, FIXTURE_PASS);

      assert.exitCode(result, 0);
      assert.includes(result, 'TAP version 13');
      assert.includes(result, '(daemon)');
      assert.includes(result, '# pass 3');
      assert.includes(result, '# fail 0');
    },
  );

  daemonTest(
    'failing test through daemon -> exit 1, TAP shows failures',
    async (assert, project) => {
      await cli(project, 'daemon start');
      const result = await cli(project, FIXTURE_FAIL, { failOk: true });

      assert.exitCode(result, 1);
      assert.includes(result, '(daemon)');
      assert.regex(result, /# fail [1-9]/);
    },
  );

  daemonTest(
    'two consecutive daemon-routed runs both succeed (warm context reuse)',
    async (assert, project) => {
      await cli(project, 'daemon start');
      const r1 = await cli(project, FIXTURE_PASS);
      const r2 = await cli(project, FIXTURE_PASS);

      assert.exitCode(r1, 0);
      assert.exitCode(r2, 0);
      assert.includes(r1, '# pass 3');
      assert.includes(r2, '# pass 3');
      assert.includes(r1, '(daemon)');
      assert.includes(r2, '(daemon)');
    },
  );

  daemonTest(
    'TAP version 13 header appears exactly once per daemon-routed run',
    async (assert, project) => {
      await cli(project, 'daemon start');
      const result = await cli(project, FIXTURE_PASS);
      const matches = result.stdout.match(/^TAP version 13\b/gm) || [];

      assert.strictEqual(
        matches.length,
        1,
        `expected exactly one TAP version header, got ${matches.length}`,
      );
    },
  );

  daemonTest('multi-file run uses concurrent groups inside the daemon', async (assert, project) => {
    await cli(project, 'daemon start');
    const result = await cli(project, `${FIXTURE_PASS} ${FIXTURE_PASS_JS}`);

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
  });

  daemonTest(
    'multi-file run with one failing file -> exit 1, fails counted',
    async (assert, project) => {
      await cli(project, 'daemon start');
      const result = await cli(project, `${FIXTURE_PASS} ${FIXTURE_FAIL}`, { failOk: true });

      assert.exitCode(result, 1);
      // Passing fixture contributes 3 passes, failing fixture has at least one fail.
      assert.regex(result, /# pass [3-9]/);
      assert.regex(result, /# fail [1-9]/);
      assert.includes(result, '(daemon)');
    },
  );

  daemonTest(
    'failing run does not poison page reuse — next passing run still passes',
    async (assert, project) => {
      // Composes 'failing test through daemon' + 'two consecutive daemon-routed runs'
      // — neither covers the cross-product. PR2's reuse path stashes the page on
      // the slot whenever the page is healthy, regardless of test exit code; a
      // future "be defensive" refactor that gated the stash on `exitCode === 0`
      // would silently disable reuse for any user whose first run after daemon
      // start happens to fail. This test would catch that.
      await cli(project, 'daemon start');
      const fail = await cli(project, FIXTURE_FAIL, { failOk: true });
      const pass = await cli(project, FIXTURE_PASS);

      assert.exitCode(fail, 1);
      assert.regex(fail, /# fail [1-9]/);
      assert.exitCode(pass, 0);
      assert.includes(pass, '# pass 3');
      assert.includes(pass, '(daemon)');
    },
  );
});

module('Commands | Daemon | bypass', { concurrency: true }, () => {
  daemonTest(
    '--no-daemon bypasses a running daemon (no "(daemon)" suffix)',
    async (assert, project) => {
      await cli(project, 'daemon start');
      const result = await cli(project, `--no-daemon ${FIXTURE_PASS}`);

      assert.exitCode(result, 0);
      assert.includes(result, '# pass 3');
      assert.notIncludes(result, '(daemon)');
    },
  );

  daemonTest('QUNITX_NO_DAEMON env var bypasses a running daemon', async (assert, project) => {
    await cli(project, 'daemon start');
    const result = await cli(project, FIXTURE_PASS, {
      env: { ...CLI_ENV, QUNITX_NO_DAEMON: '1' },
    });

    assert.exitCode(result, 0);
    assert.includes(result, '# pass 3');
    assert.notIncludes(result, '(daemon)');
  });

  daemonTest('CI env var bypasses a running daemon', async (assert, project) => {
    await cli(project, 'daemon start');
    const result = await cli(project, FIXTURE_PASS, { env: { ...CLI_ENV, CI: '1' } });

    assert.exitCode(result, 0);
    assert.includes(result, '# pass 3');
    assert.notIncludes(result, '(daemon)');
  });

  daemonTest(
    'QUNITX_DAEMON=1 overrides CI=1 (multi-invocation CI opt-in)',
    async (assert, project) => {
      // Default: CI=1 bypasses the daemon for single-invocation jobs (most CI). When
      // both CI=1 and QUNITX_DAEMON=1 are set, the explicit opt-in wins — multi-
      // invocation CI flows (monorepos, pre-commit hooks doing N qunitx calls) need
      // to be able to share the warm daemon across calls.
      await cli(project, 'daemon start');
      const result = await cli(project, FIXTURE_PASS, {
        env: { ...CLI_ENV, CI: '1', QUNITX_DAEMON: '1' },
      });

      assert.exitCode(result, 0);
      assert.includes(result, '# pass 3');
      assert.includes(result, '(daemon)');
    },
  );
});

module('Commands | Daemon | auto-spawn', { concurrency: true }, () => {
  daemonTest(
    'QUNITX_DAEMON=1 with no daemon -> auto-spawns and routes',
    async (assert, project) => {
      const result = await cli(project, FIXTURE_PASS, {
        env: { ...CLI_ENV, QUNITX_DAEMON: '1' },
      });

      assert.exitCode(result, 0);
      assert.includes(result, '# pass 3');
      assert.includes(result, '(daemon)');

      // Daemon must still be running for subsequent invocations to reuse.
      const status = await cli(project, 'daemon status');
      assert.exitCode(status, 0);
      assert.includes(status, 'Daemon running');
    },
  );

  daemonTest(
    'without QUNITX_DAEMON, no daemon is spawned and run is local',
    async (assert, project) => {
      const result = await cli(project, FIXTURE_PASS);

      assert.exitCode(result, 0);
      assert.includes(result, '# pass 3');
      assert.notIncludes(result, '(daemon)');

      const status = await cli(project, 'daemon status', { failOk: true });
      assert.exitCode(status, 1);
      assert.includes(status, 'No daemon running');
    },
  );

  daemonTest(
    'QUNITX_DAEMON=1 with daemon already running -> reuses it',
    async (assert, project) => {
      await cli(project, 'daemon start');
      const startupPid = await readDaemonPid(project);

      const result = await cli(project, FIXTURE_PASS, {
        env: { ...CLI_ENV, QUNITX_DAEMON: '1' },
      });
      assert.exitCode(result, 0);
      assert.includes(result, '(daemon)');

      // Same daemon instance — no double-spawn.
      const samePid = await readDaemonPid(project);
      assert.strictEqual(samePid, startupPid, 'daemon process unchanged');
    },
  );

  daemonTest(
    'QUNITX_DAEMON=1 + --no-daemon -> bypass wins, runs locally',
    async (assert, project) => {
      const result = await cli(project, `--no-daemon ${FIXTURE_PASS}`, {
        env: { ...CLI_ENV, QUNITX_DAEMON: '1' },
      });
      assert.exitCode(result, 0);
      assert.includes(result, '# pass 3');
      assert.notIncludes(result, '(daemon)');

      // No daemon spawned because --no-daemon vetoes auto-spawn.
      const status = await cli(project, 'daemon status', { failOk: true });
      assert.exitCode(status, 1);
    },
  );
});

module('Commands | Daemon | idle timeout', { concurrency: true }, () => {
  // Integration coverage focuses on the three distinct daemon behaviors the env var
  // can drive — short timeout shuts down, "false" stays alive, invalid value warns
  // and still starts. Parser semantics (units, fractions, edge cases) are exhausted
  // in test/utils/parse-daemon-idle-timeout-test.ts; we don't re-test them through
  // process spawns here.

  daemonTest(
    'a short QUNITX_DAEMON_IDLE_TIMEOUT shortens the window and the daemon self-exits',
    async (assert, project) => {
      const start = await cli(project, 'daemon start', {
        env: { ...CLI_ENV, QUNITX_DAEMON_IDLE_TIMEOUT: '500ms' },
      });
      // exitCode 0 already certifies the daemon was up at cli-return time
      // (the start path waits for both the info file AND a successful ping
      // before returning). An `existsSync` line right after races the 500 ms
      // timer on loaded Windows CI — the daemon may have already self-shut-
      // down — so we omit it; `waitForFileGone` is the load-bearing check.
      assert.exitCode(start, 0);
      const gone = await waitForFileGone(project.infoPath, 3000);
      assert.ok(gone, 'daemon self-shut-down within the configured window');
    },
  );

  daemonTest('QUNITX_DAEMON_IDLE_TIMEOUT=false disables auto-shutdown', async (assert, project) => {
    // Paired with the short-timeout test above. If the Infinity branch in
    // resetIdleTimer regressed and Node's setTimeout clamp converted Infinity to
    // 1 ms, the daemon would vanish well before this 700 ms wait elapses — strictly
    // longer than the 500 ms timer the previous test exercised, so a clamp bug is
    // unambiguously visible here.
    const start = await cli(project, 'daemon start', {
      env: { ...CLI_ENV, QUNITX_DAEMON_IDLE_TIMEOUT: 'false' },
    });
    assert.exitCode(start, 0);

    await new Promise((r) => setTimeout(r, 700));

    assert.ok(existsSync(project.infoPath), 'info file still present after the wait');
    const status = await cli(project, 'daemon status');
    assert.exitCode(status, 0);
    assert.includes(status, 'Daemon running');
  });

  daemonTest(
    'invalid QUNITX_DAEMON_IDLE_TIMEOUT prints a warning to stderr and starts on the default',
    async (assert, project) => {
      const start = await cli(project, 'daemon start', {
        env: { ...CLI_ENV, QUNITX_DAEMON_IDLE_TIMEOUT: 'garbage-value' },
      });
      assert.exitCode(start, 0, 'malformed env value must not block daemon startup');
      assert.includes(start, 'Daemon started', 'daemon still starts on the default');

      // Warning is emitted by the CLI process before spawning (so it isn't lost to
      // the daemon's detached stdio:'ignore'). Exact phrasing is exercised in the
      // parser unit test; here we just confirm the warning reached the user's stderr.
      assert.ok(
        start.stderr.includes('QUNITX_DAEMON_IDLE_TIMEOUT'),
        `warning should mention the env var name; got stderr: ${JSON.stringify(start.stderr)}`,
      );
      assert.ok(
        start.stderr.includes('garbage-value'),
        'warning should quote the bad value so the user knows what to fix',
      );
    },
  );
});

module('Commands | Daemon | crash recovery', { concurrency: true }, () => {
  // Linux-only: relies on /proc/<pid>/task/<pid>/children to find the daemon's Chrome.
  // macOS/Windows lack a portable equivalent; the recovery code path itself is the same.
  const isLinux = process.platform === 'linux';

  daemonTest('daemon relaunches Chrome after it is SIGKILLed', async (assert, project) => {
    if (!isLinux) return assert.ok(true, 'skipped on non-linux');

    await cli(project, 'daemon start');
    const before = await cli(project, FIXTURE_PASS);
    assert.includes(before, '# pass 3');

    const daemonPid = await readDaemonPid(project);
    const killed = await killDaemonChrome(daemonPid);
    assert.ok(killed, "killed daemon's Chrome process");
    // Give Playwright's CDP transport a moment to flag the connection dead.
    await new Promise((r) => setTimeout(r, 200));

    const after = await cli(project, FIXTURE_PASS);
    assert.exitCode(after, 0);
    assert.includes(after, '# pass 3');
    assert.includes(after, '(daemon)');
  });

  daemonTest(
    'successful run resets the crash counter (consecutive crashes survive)',
    async (assert, project) => {
      if (!isLinux) return assert.ok(true, 'skipped on non-linux');

      // Two back-to-back kill+run cycles. If the counter were not reset by the successful
      // run between, the second cycle would push the daemon past MAX_CONSECUTIVE_CRASHES
      // and the third invocation (status check) would fail.
      await cli(project, 'daemon start');
      const startupPid = await readDaemonPid(project);

      // Cycle 1
      const cycle1Killed = await killDaemonChrome(startupPid);
      assert.ok(cycle1Killed, 'cycle 1: killed Chrome');
      await new Promise((r) => setTimeout(r, 200));
      const cycle1 = await cli(project, FIXTURE_PASS);
      assert.exitCode(cycle1, 0);
      assert.includes(cycle1, '# pass 3');

      // Cycle 2
      const cycle2Killed = await killDaemonChrome(startupPid);
      assert.ok(cycle2Killed, 'cycle 2: killed Chrome');
      await new Promise((r) => setTimeout(r, 200));
      const cycle2 = await cli(project, FIXTURE_PASS);
      assert.exitCode(cycle2, 0);
      assert.includes(cycle2, '# pass 3');

      // Daemon must still be the same process (not restarted, not dead).
      const status = await cli(project, 'daemon status');
      assert.exitCode(status, 0);
      const stillAlivePid = Number(/pid:\s+(\d+)/.exec(status.stdout)?.[1]);
      assert.strictEqual(stillAlivePid, startupPid, 'daemon process survived both crash cycles');
    },
  );

  daemonTest('post-run check recovers when Chrome dies during the run', async (assert, project) => {
    if (!isLinux) return assert.ok(true, 'skipped on non-linux');

    // Race condition: kill Chrome while a run is in flight. That run will fail (browser
    // mid-test died), but the daemon's post-run check must detect the disconnected
    // browser and relaunch so the *next* run succeeds.
    await cli(project, 'daemon start');
    await cli(project, FIXTURE_PASS); // warm-up: ensures daemon is ready

    const daemonPid = await readDaemonPid(project);
    // Schedule the kill ~150ms in. The fixture takes ~140ms; the kill almost always
    // lands while page.goto / WS handshake / first test is in flight.
    const killTimer = setTimeout(() => {
      void killDaemonChrome(daemonPid);
    }, 150);

    const inFlight = await cli(project, FIXTURE_PASS, { failOk: true });
    clearTimeout(killTimer);

    // The in-flight run may either complete (kill landed too late) or fail (kill
    // killed Chrome mid-run). Either is acceptable — what matters is that the next
    // run succeeds, proving the daemon recovered rather than getting stuck.
    assert.ok(
      inFlight.code === 0 || inFlight.code === 1,
      `in-flight run produced an exit code (got ${inFlight.code})`,
    );

    const next = await cli(project, FIXTURE_PASS);
    assert.exitCode(next, 0);
    assert.includes(next, '# pass 3');
    assert.includes(next, '(daemon)');
  });
});

async function readDaemonPid(project: DaemonProject): Promise<number> {
  const status = await cli(project, 'daemon status');
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
