import path from 'node:path';
import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { spawnCapture } from './shell.ts';
import { tempDir } from './temp-dir.ts';

// Use a fixture script rather than `node -e` so the test command line has no whitespace
// inside any arg — shell.ts's parseCommand splits on whitespace, which is correct for the
// qunitx CLI invocations the helper actually runs but would mangle inline scripts. The
// fields asserted below are exactly the diagnostic surface custom-asserts.ts forwards into
// failure messages, so a regression here would silently re-flatten Windows flake reports
// back to "stdout truncated, ¯\_(ツ)_/¯".
// Use the literal token `node` — parseCommand swaps it for process.execPath internally.
// `${process.execPath} ${FIXTURE}` would shell-fragment on Windows because
// `C:\\Program Files\\nodejs\\node.exe` contains a space.
const FIXTURE = path.join(process.cwd(), 'test/fixtures/spawn-capture-fixture.js');
const cmd = (mode: string) => `node ${FIXTURE} ${mode}`;

module('Helpers | spawnCapture | success path', { concurrency: true }, () => {
  test('captures stdout, stderr, exit code 0, null signal, and a positive duration', async (assert) => {
    const result = await spawnCapture(cmd('success'));
    assert.equal(result.stdout, 'hello');
    assert.equal(result.stderr, 'warn');
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.signal, null);
    assert.ok(result.duration > 0, `duration is positive (got ${result.duration})`);
  });

  test('records stdout chunks with arrival timestamps ordered by time', async (assert) => {
    // Two writes separated by 50 ms — the captured chunks must preserve order with strictly
    // non-decreasing timestamps so the "last chunk at X ms" line in failure output is meaningful.
    const result = await spawnCapture(cmd('two-chunks'));
    assert.equal(result.stdout, 'ab');
    assert.ok(result.stdoutChunks.length >= 1, 'at least one stdout chunk recorded');
    for (let i = 1; i < result.stdoutChunks.length; i++) {
      assert.ok(
        result.stdoutChunks[i].time >= result.stdoutChunks[i - 1].time,
        'chunk timestamps are monotonically non-decreasing',
      );
    }
  });
});

module('Helpers | spawnCapture | shell-style env prefix', { concurrency: true }, () => {
  test('forwards leading VAR=value tokens as child env (TZ=UTC node …)', async (assert) => {
    // Regression: spawn() runs no shell, so the literal `TZ=UTC node ...` form that
    // exec()/sh -c handled transparently was being interpreted as the binary name and
    // failing with `spawn TZ=UTC ENOENT`. parseCommand now peels these off and the spawn
    // call merges them into env — verified here against a fixture that echoes the var.
    const result = await spawnCapture(`MY_TEST_VAR=hello node ${FIXTURE} echo-env`);
    assert.equal(result.stdout, 'MY_TEST_VAR=hello');
    assert.strictEqual(result.code, 0);
  });

  test('supports multiple consecutive VAR=value prefixes', async (assert) => {
    // `A=1 B=2 cmd` shell semantics — every leading assignment must end up in env, not in
    // argv. The fixture echoes only MY_TEST_VAR; the FORCE_NOOP=1 prefix proves the parser
    // doesn't mis-route extra assignments into args.
    const result = await spawnCapture(`FORCE_NOOP=1 MY_TEST_VAR=world node ${FIXTURE} echo-env`);
    assert.equal(result.stdout, 'MY_TEST_VAR=world');
  });
});

module('Helpers | spawnCapture | failure paths', { concurrency: true }, () => {
  test('rejects with a CapturedError carrying the full diagnostic surface on non-zero exit', async (assert) => {
    await assert.rejects(
      spawnCapture(cmd('fail')),
      (err: Error & { code: number; signal: null; stdout: string; duration: number }) => {
        assert.equal(err.stdout, 'partial', 'partial stdout preserved on rejection');
        assert.strictEqual(err.code, 7);
        assert.strictEqual(err.signal, null);
        assert.ok(err.duration > 0, 'duration recorded even on failure');
        return true;
      },
    );
  });

  test('the message ends with what the child last said on stderr, on the same line', async (assert) => {
    // CI failures are read from annotations, which keep the first line of the message only.
    await assert.rejects(spawnCapture(cmd('fail-saying-why')), (err: Error) => {
      assert.true(err.message.startsWith('Process exited with code 3 after '), err.message);
      assert.true(err.message.endsWith(' — Error: the actual reason'), 'the last line, uncoloured');
      assert.false(err.message.includes('\n'), 'still one line');
      return true;
    });
  });

  test('rejects with a CapturedError reporting the terminating signal when timed out', async (assert) => {
    // Long sleep + short timeout — spawnCapture sends SIGTERM, the child exits via signal,
    // and the rejection's `signal` field is what tells us "this was a timeout, not a crash."
    // exec() would have hidden this distinction on Windows entirely.
    await assert.rejects(
      spawnCapture(cmd('sleep'), { timeout: 100 }),
      (err: Error & { code: number | null; signal: NodeJS.Signals | null; duration: number }) => {
        assert.ok(err.signal !== null || err.code !== 0, 'killed by signal or non-zero exit');
        assert.ok(err.duration < 4_000, `terminated quickly (${err.duration} ms)`);
        return true;
      },
    );
  });
});

// A timed-out command is not the only thing that has to stop. The BROWSER it launched is a child
// of that child, and `child.kill()` never touched it — so every timeout left a browser running,
// competing for a machine that was already too slow to finish in time. On the Firefox-on-Windows
// lane that compounded until every test took four times its usual duration and the ones that fell
// off the end reported `page.goto: Timeout 60000ms exceeded`.
module('Test Helpers | spawnCapture | timing out', { concurrency: true }, () => {
  test('stops the whole tree, not just the command', async (assert) => {
    await using directory = await tempDir('spawn-capture-tree');
    const marker = path.join(directory.path, 'alive.txt');

    // Rejects: the fixture is killed, so it never exits 0. The rejection is the timeout working.
    await spawnCapture(`node test/fixtures/spawns-a-grandchild.ts ${marker}`, {
      // Generous, because what is being timed is two node boots on a runner already doing sixteen
      // other things — not the kill, which is what this test is actually about.
      timeout: 5_000,
    }).catch(() => null);
    // Past the SIGTERM → SIGKILL escalation, so a grandchild that ignored the first is gone too.
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    const before = await fs.readFile(marker, 'utf8').catch(() => '');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = await fs.readFile(marker, 'utf8').catch(() => '');

    assert.ok(before.length > 0, 'the grandchild really was running');
    assert.strictEqual(
      after.length,
      before.length,
      'and it stopped when its parent was timed out, rather than outliving the test',
    );
  });
});

// `spawnCapture` hands its child exactly the environment it is given — none, when given none —
// so a test that starts the CLI through it directly runs `node` with no PATH and Chrome with no
// CHROME_BIN. On a NixOS machine that is invisible: util-linux `script` falls back to the passwd
// shell, zsh sources /etc/zshenv, and PATH comes back by accident. On an ubuntu runner the passwd
// shell sources nothing, `node` is not found, and every such test exits 1 — which is how six vim
// tests passed locally and failed in CI. `execute` passes `process.env` and takes the browser
// semaphore besides, so a test that runs the CLI goes through it or passes `env` itself.
module('Helpers | spawnCapture adoption', { concurrency: true }, () => {
  test('a test that runs the CLI through spawnCapture gives it an environment', async (assert) => {
    const testRoot = path.join(process.cwd(), 'test');
    const files = await testFilesUnder(testRoot);
    assert.ok(files.length > 50, 'the walk actually traversed the test tree');

    const offenders: string[] = [];
    for (const file of files) {
      // The helper and this guard carry the call as text; neither runs the CLI through it.
      if (/helpers\/shell(-test)?\.ts$/.test(file.replaceAll('\\', '/'))) continue;
      const source = await fs.readFile(file, 'utf8');
      if (!source.includes('cli.ts')) continue;
      for (const call of callsTo(source, 'spawnCapture(')) {
        if (!/\benv\b/.test(call)) offenders.push(path.relative(testRoot, file));
      }
    }

    assert.deepEqual(
      [...new Set(offenders)],
      [],
      'run the CLI through execute(), or pass `env: { ...process.env }` — without it the child ' +
        'has no PATH, and CI cannot find node',
    );
  });
});

/** Every test file under `directory`, recursively. */
async function testFilesUnder(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return testFilesUnder(full);

      return Promise.resolve(full.endsWith('-test.ts') ? [full] : []);
    }),
  );

  return nested.flat();
}

/** The text of each call to `callee`, from its name to its matching close paren. */
function callsTo(source: string, callee: string): string[] {
  const calls: string[] = [];
  let at = source.indexOf(callee);
  while (at !== -1) {
    let depth = 0;
    let end = at + callee.length - 1;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    calls.push(source.slice(at, end + 1));
    at = source.indexOf(callee, end);
  }

  return calls;
}
