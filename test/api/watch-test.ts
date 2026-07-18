import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import '../helpers/custom-asserts.ts';
import { watch } from '../../lib/api/index.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';

const SOURCE = 'test/helpers/passing-tests.js';

/** Waits for `event` to fire on the session, or rejects once `timeoutMs` elapses. */
function nextEvent<Payload>(
  session: { once: (event: never, listener: (payload: Payload) => void) => unknown },
  event: string,
  timeoutMs = 30_000,
): Promise<Payload> {
  return new Promise<Payload>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for "${event}"`)),
      timeoutMs,
    );
    session.once(event as never, (payload: Payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Copies the fixture so each test edits a file only it owns. */
async function isolatedFixture() {
  const filePath = `tmp/api-watch-${randomUUID()}.js`;
  await fs.writeFile(filePath, await fs.readFile(SOURCE, 'utf8'));
  return filePath;
}

module('JS API: watch()', { concurrency: true }, () => {
  test('resolves once the first run is complete and the watchers are armed', async (assert) => {
    const permit = await acquireBrowser();
    const filePath = await isolatedFixture();
    const session = await watch({ files: [filePath], output: `tmp/api-${randomUUID()}` });
    try {
      // Awaiting watch() means "the session is live", so the first result is already there.
      assert.equal(session.lastResult!.counts.total, 3);
      assert.true(session.lastResult!.ok);
    } finally {
      await session.close();
      permit.release();
      await fs.rm(filePath, { force: true });
    }
  });

  test('reruns and emits a fresh result when a watched file changes', async (assert) => {
    const permit = await acquireBrowser();
    const filePath = await isolatedFixture();
    const session = await watch({ files: [filePath], output: `tmp/api-${randomUUID()}` });
    try {
      const changed = nextEvent<string[]>(session, 'change');
      const rerun = nextEvent<{ counts: { total: number } }>(session, 'runEnd');

      const original = await fs.readFile(filePath, 'utf8');
      await fs.writeFile(filePath, `${original}\n// touched\n`);

      assert.includes((await changed).join(','), 'api-watch');
      assert.equal((await rerun).counts.total, 3);
    } finally {
      await session.close();
      permit.release();
      await fs.rm(filePath, { force: true });
    }
  });

  test('close() is idempotent and leaves no listeners behind', async (assert) => {
    const permit = await acquireBrowser();
    const filePath = await isolatedFixture();
    // A watch session must not install the CLI's process-wide SIGTERM handler — the host owns
    // its own signal handling.
    const sigtermBefore = process.listenerCount('SIGTERM');
    const session = await watch({ files: [filePath], output: `tmp/api-${randomUUID()}` });

    assert.equal(process.listenerCount('SIGTERM'), sigtermBefore);

    await session.close();
    await session.close();
    assert.true(true, 'a second close() resolves without throwing');

    permit.release();
    await fs.rm(filePath, { force: true });
  });
});
