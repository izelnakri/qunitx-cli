import { module, test } from 'qunitx';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as Client from '../../../lib/commands/daemon/client.ts';
import * as Paths from '../../../lib/commands/daemon/paths.ts';
import '../../helpers/custom-asserts.ts';

// The only three variables Client consults. They are cleared before each invocation so the
// test states the whole truth about them: the suite runner exports QUNITX_NO_DAEMON=1 for
// every worker, and GitHub Actions exports CI=true, either of which would otherwise decide
// the answer before the case under test got a say.
const DAEMON_ENV_KEYS = ['QUNITX_DAEMON', 'QUNITX_NO_DAEMON', 'CI'];

interface Invocation {
  /** Overrides layered onto the ambient environment, after DAEMON_ENV_KEYS are cleared. */
  env?: NodeJS.ProcessEnv;
  /** argv past `node cli.ts`. */
  args?: string[];
  /** Whether an info file (the cross-platform "a daemon is present" sentinel) exists. */
  daemonRunning?: boolean;
}

/**
 * Runs `fn` as if the cli had been invoked with the given env/argv in a project whose daemon
 * is (or is not) already running, then restores every stubbed global.
 *
 * Synchronous on purpose: process.env/argv/cwd are process-wide, so a sync body is what
 * guarantees a concurrent sibling test can never observe the stubbed values.
 *
 * The cwd is synthetic — Paths only hashes the string, it never touches the directory — so
 * each invocation gets its own private info-file slot without a fixture project on disk.
 */
function withInvocation<T>(
  { env = {}, args = [], daemonRunning = false }: Invocation,
  fn: () => T,
): T {
  const cwd = path.join(path.sep, `qunitx-client-test-${randomUUID()}`);
  const original = { env: process.env, argv: process.argv, cwd: process.cwd };
  // The ambient environment is kept and only the daemon keys are replaced. Wiping it wholesale
  // also wipes TEMP/TMP, and os.tmpdir() — which is where Paths puts the info file — is derived
  // from those on Windows. The sentinel then got written to one tmpdir and looked for in
  // another, so every "a daemon is running" case read as false on the windows lanes only.
  const stubbedEnv = { ...original.env };
  for (const key of DAEMON_ENV_KEYS) delete stubbedEnv[key];

  process.env = { ...stubbedEnv, ...env };
  process.argv = ['node', 'cli.ts', ...args];
  process.cwd = () => cwd;
  try {
    if (daemonRunning) {
      fs.mkdirSync(Paths.dir(cwd), { recursive: true });
      fs.writeFileSync(Paths.info(cwd), JSON.stringify({ pid: process.pid }));
    }
    return fn();
  } finally {
    fs.rmSync(Paths.dir(cwd), { recursive: true, force: true });
    process.env = original.env;
    process.argv = original.argv;
    process.cwd = original.cwd;
  }
}

const shouldUse = (invocation: Invocation): boolean => withInvocation(invocation, Client.shouldUse);
const shouldAutoSpawn = (invocation: Invocation): boolean =>
  withInvocation(invocation, Client.shouldAutoSpawn);

// shouldUse() is the cli's primary dispatch check (cli.ts: `let useDaemon = Client.shouldUse()`).
// Every precedence rule below used to be covered only by a `daemon start` + real run e2e in
// test/commands/daemon-test.ts, at ~37s per rule; the single surviving e2e there
// ('--no-daemon bypasses a running daemon') proves the predicate is genuinely wired to dispatch.
module('Daemon | Client.shouldUse', { concurrency: true }, () => {
  test('routes to the daemon when one is running and nothing opts out', (assert) => {
    assert.true(shouldUse({ daemonRunning: true, args: ['test/foo-test.ts'] }));
  });

  test('is false when no daemon is running for this cwd', (assert) => {
    assert.false(shouldUse({ daemonRunning: false, args: ['test/foo-test.ts'] }));
  });

  test('--no-daemon bypasses a running daemon', (assert) => {
    assert.false(shouldUse({ daemonRunning: true, args: ['--no-daemon', 'test/foo-test.ts'] }));
  });

  test('QUNITX_NO_DAEMON=1 bypasses a running daemon', (assert) => {
    assert.false(
      shouldUse({
        daemonRunning: true,
        env: { QUNITX_NO_DAEMON: '1' },
        args: ['test/foo-test.ts'],
      }),
    );
  });

  test('CI=1 bypasses a running daemon', (assert) => {
    assert.false(shouldUse({ daemonRunning: true, env: { CI: '1' }, args: ['test/foo-test.ts'] }));
    assert.false(
      shouldUse({ daemonRunning: true, env: { CI: 'true' }, args: ['test/foo-test.ts'] }),
    );
  });

  test('QUNITX_DAEMON=1 overrides the CI=1 bypass (multi-invocation CI opt-in)', (assert) => {
    assert.true(
      shouldUse({
        daemonRunning: true,
        env: { CI: '1', QUNITX_DAEMON: '1' },
        args: ['test/foo-test.ts'],
      }),
    );
  });

  test('QUNITX_NO_DAEMON=1 beats QUNITX_DAEMON=1 (opt-out wins over opt-in)', (assert) => {
    assert.false(
      shouldUse({
        daemonRunning: true,
        env: { QUNITX_DAEMON: '1', QUNITX_NO_DAEMON: '1' },
        args: ['test/foo-test.ts'],
      }),
    );
  });

  test('--no-daemon beats QUNITX_DAEMON=1 (per-invocation flag wins over env)', (assert) => {
    assert.false(
      shouldUse({
        daemonRunning: true,
        env: { QUNITX_DAEMON: '1' },
        args: ['--no-daemon', 'test/foo-test.ts'],
      }),
    );
  });

  test('--watch and -w bypass the daemon (watch owns its own browser lifecycle)', (assert) => {
    assert.false(shouldUse({ daemonRunning: true, args: ['test/foo-test.ts', '--watch'] }));
    assert.false(shouldUse({ daemonRunning: true, args: ['test/foo-test.ts', '-w'] }));
  });

  test('--open, -o and --open=<browser> bypass the daemon', (assert) => {
    assert.false(shouldUse({ daemonRunning: true, args: ['test/foo-test.ts', '--open'] }));
    assert.false(shouldUse({ daemonRunning: true, args: ['test/foo-test.ts', '-o'] }));
    assert.false(shouldUse({ daemonRunning: true, args: ['test/foo-test.ts', '--open=firefox'] }));
  });

  test('--search / -s / --print / --preview bypass the daemon (they never touch a browser)', (assert) => {
    for (const flag of ['--search', '-s', '--print', '--preview']) {
      assert.false(
        shouldUse({ daemonRunning: true, args: ['test/foo-test.ts', flag, 'Cart'] }),
        `${flag} bypasses`,
      );
    }
  });

  test('-t / -m keep routing through the daemon (a filter is not a bypass)', (assert) => {
    assert.true(shouldUse({ daemonRunning: true, args: ['test/foo-test.ts', '-t', 'Cart'] }));
    assert.true(shouldUse({ daemonRunning: true, args: ['test/foo-test.ts', '--filter=Cart'] }));
  });

  test('a greedy filter value is never mistaken for a bypass flag', (assert) => {
    // Regression guard for the tokenizer reuse in isDaemonEligible: a bare -t swallows the
    // following bare words, so "watch" and "open" here are filter text, not flags.
    assert.true(
      shouldUse({ daemonRunning: true, args: ['test/foo-test.ts', '-t', 'watch', 'open', 'mode'] }),
    );
    assert.true(shouldUse({ daemonRunning: true, args: ['--filter=--no-daemon', 'test/a.ts'] }));
  });

  test('a positional input after -- is never read as a bypass flag', (assert) => {
    assert.true(shouldUse({ daemonRunning: true, args: ['-t', 'Cart', '--', '--watch'] }));
  });
});

// shouldAutoSpawn() is the cli's secondary check: it only fires when shouldUse() said no
// (cli.ts: `if (!useDaemon && Client.shouldAutoSpawn())`), so its whole job is "the user
// opted in, this invocation is eligible, and there is nothing to reuse yet".
module('Daemon | Client.shouldAutoSpawn', { concurrency: true }, () => {
  test('is false without QUNITX_DAEMON even when no daemon is running', (assert) => {
    assert.false(shouldAutoSpawn({ daemonRunning: false, args: ['test/foo-test.ts'] }));
  });

  test('is true with QUNITX_DAEMON=1 and no daemon running', (assert) => {
    assert.true(
      shouldAutoSpawn({
        daemonRunning: false,
        env: { QUNITX_DAEMON: '1' },
        args: ['test/foo-test.ts'],
      }),
    );
  });

  test('is false when a daemon already runs — shouldUse takes that path', (assert) => {
    assert.false(
      shouldAutoSpawn({
        daemonRunning: true,
        env: { QUNITX_DAEMON: '1' },
        args: ['test/foo-test.ts'],
      }),
    );
  });

  test('is true with QUNITX_DAEMON=1 under CI=1 (explicit opt-in overrides the CI bypass)', (assert) => {
    assert.true(
      shouldAutoSpawn({
        daemonRunning: false,
        env: { CI: '1', QUNITX_DAEMON: '1' },
        args: ['test/foo-test.ts'],
      }),
    );
  });

  test('is false with QUNITX_DAEMON=1 + --no-daemon (the flag vetoes auto-spawn)', (assert) => {
    assert.false(
      shouldAutoSpawn({
        daemonRunning: false,
        env: { QUNITX_DAEMON: '1' },
        args: ['--no-daemon', 'test/foo-test.ts'],
      }),
    );
  });

  test('is false with QUNITX_DAEMON=1 + QUNITX_NO_DAEMON=1', (assert) => {
    assert.false(
      shouldAutoSpawn({
        daemonRunning: false,
        env: { QUNITX_DAEMON: '1', QUNITX_NO_DAEMON: '1' },
        args: ['test/foo-test.ts'],
      }),
    );
  });

  test('is false with QUNITX_DAEMON=1 in watch, open or search modes', (assert) => {
    for (const flag of ['--watch', '-w', '--open', '-o', '--search', '-s']) {
      assert.false(
        shouldAutoSpawn({
          daemonRunning: false,
          env: { QUNITX_DAEMON: '1' },
          args: ['test/foo-test.ts', flag],
        }),
        `${flag} vetoes auto-spawn`,
      );
    }
  });
});
