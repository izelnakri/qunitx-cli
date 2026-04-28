import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { shouldShowDaemonHint, maybePrintDaemonHint } from '../../lib/utils/daemon-hint.ts';
import '../helpers/custom-asserts.ts';

interface BaseCtx {
  durationMs: number;
  watch: boolean;
  daemonMode: boolean;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
}

const BASE_CTX: BaseCtx = {
  durationMs: 1_000,
  watch: false,
  daemonMode: false,
  env: {},
  isTTY: true,
};

const tmpSentinel = (): string => path.join(os.tmpdir(), `qunitx-hint-${randomUUID()}`);

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

module('Utils | DaemonHint | shouldShowDaemonHint', { concurrency: true }, () => {
  test('shows on slow non-CI TTY run with empty env', (assert) => {
    assert.true(shouldShowDaemonHint(BASE_CTX));
  });

  test('suppresses when CI is set', (assert) => {
    assert.false(shouldShowDaemonHint({ ...BASE_CTX, env: { CI: 'true' } }));
    assert.false(shouldShowDaemonHint({ ...BASE_CTX, env: { CI: '1' } }));
  });

  test('suppresses when QUNITX_DAEMON is set (already opted in)', (assert) => {
    assert.false(shouldShowDaemonHint({ ...BASE_CTX, env: { QUNITX_DAEMON: '1' } }));
  });

  test('suppresses when QUNITX_NO_DAEMON is set (explicit opt-out)', (assert) => {
    assert.false(shouldShowDaemonHint({ ...BASE_CTX, env: { QUNITX_NO_DAEMON: '1' } }));
  });

  test('suppresses when QUNITX_HINT_SHOWN is set (per-session override)', (assert) => {
    assert.false(shouldShowDaemonHint({ ...BASE_CTX, env: { QUNITX_HINT_SHOWN: '1' } }));
  });

  test('suppresses in --watch mode (own browser lifecycle)', (assert) => {
    assert.false(shouldShowDaemonHint({ ...BASE_CTX, watch: true }));
  });

  test('suppresses inside the daemon process itself', (assert) => {
    assert.false(shouldShowDaemonHint({ ...BASE_CTX, daemonMode: true }));
  });

  test('threshold: shows at 500ms, suppresses at 499ms', (assert) => {
    assert.false(shouldShowDaemonHint({ ...BASE_CTX, durationMs: 499 }));
    assert.true(shouldShowDaemonHint({ ...BASE_CTX, durationMs: 500 }));
    assert.true(shouldShowDaemonHint({ ...BASE_CTX, durationMs: 1_500 }));
  });

  test('suppresses when stderr is not a TTY', (assert) => {
    assert.false(shouldShowDaemonHint({ ...BASE_CTX, isTTY: false }));
  });
});

module('Utils | DaemonHint | maybePrintDaemonHint', { concurrency: true }, () => {
  test('writes hint and creates sentinel on first call', async (assert) => {
    const sentinel = tmpSentinel();
    const writes: string[] = [];
    try {
      await maybePrintDaemonHint(BASE_CTX, {
        sentinelPath: sentinel,
        write: (t) => writes.push(t),
      });
      assert.equal(writes.length, 1, 'exactly one write');
      assert.includes(writes[0], 'QUNITX_DAEMON=1');
      assert.includes(writes[0], 'qunitx daemon --help');
      assert.true(await pathExists(sentinel), 'sentinel file created');
    } finally {
      await fs.unlink(sentinel).catch(() => {});
    }
  });

  test('skips print when sentinel already exists', async (assert) => {
    const sentinel = tmpSentinel();
    try {
      await fs.writeFile(sentinel, 'pre-existing');
      const writes: string[] = [];
      await maybePrintDaemonHint(BASE_CTX, {
        sentinelPath: sentinel,
        write: (t) => writes.push(t),
      });
      assert.equal(writes.length, 0, 'nothing written when sentinel exists');
    } finally {
      await fs.unlink(sentinel).catch(() => {});
    }
  });

  test('skips print and sentinel creation when env disqualifies', async (assert) => {
    const sentinel = tmpSentinel();
    const writes: string[] = [];
    await maybePrintDaemonHint(
      { ...BASE_CTX, env: { CI: 'true' } },
      { sentinelPath: sentinel, write: (t) => writes.push(t) },
    );
    assert.equal(writes.length, 0, 'nothing written under CI');
    assert.false(await pathExists(sentinel), 'no sentinel when suppressed');
  });

  test('skips print and sentinel creation when run is fast', async (assert) => {
    const sentinel = tmpSentinel();
    const writes: string[] = [];
    await maybePrintDaemonHint(
      { ...BASE_CTX, durationMs: 200 },
      { sentinelPath: sentinel, write: (t) => writes.push(t) },
    );
    assert.equal(writes.length, 0, 'nothing written for fast runs');
    assert.false(await pathExists(sentinel), 'no sentinel for fast runs');
  });

  test('second call after sentinel exists is silent (one-shot per machine)', async (assert) => {
    const sentinel = tmpSentinel();
    try {
      const writes: string[] = [];
      const opts = { sentinelPath: sentinel, write: (t: string) => writes.push(t) };
      await maybePrintDaemonHint(BASE_CTX, opts);
      await maybePrintDaemonHint(BASE_CTX, opts);
      assert.equal(writes.length, 1, 'only the first call printed');
    } finally {
      await fs.unlink(sentinel).catch(() => {});
    }
  });
});
