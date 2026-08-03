import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withWatch } from './helpers.ts';
import { outputDir } from '../helpers/temp-dir.ts';
import '../helpers/custom-asserts.ts';

const PASSING = 'test/fixtures/passing-tests.ts';

const GREEN_TEST = `import { module, test } from 'qunitx';
module('Watched', () => {
  test('is green', (assert) => assert.true(true));
});
`;
const RED_TEST = `import { module, test } from 'qunitx';
module('Watched', () => {
  test('is red', (assert) => assert.true(false));
});
`;

module('API | watch | session', { concurrency: true }, () => {
  test('resolves once the first run has finished, with its result in hand', async (assert) => {
    await withWatch({ inputs: [PASSING] }, (session) => {
      assert.true(session.initial.ok);
      assert.equal(session.initial.counts.total, 3);
      assert.includes(session.url, 'http://localhost:');
    });
  });

  test('rerun() resolves with that run, not the previous one', async (assert) => {
    await withWatch({ inputs: [PASSING] }, async (session) => {
      const again = await session.rerun();

      assert.true(again.ok);
      assert.equal(again.counts.total, 3, 'a full result, not an empty snapshot');
      assert.notEqual(again, session.initial, 'a distinct result object per run');
    });
  });

  test('iteration yields the initial run first, then each rerun', async (assert) => {
    await withWatch({ inputs: [PASSING] }, async (session) => {
      const seen: number[] = [];
      const consume = (async () => {
        for await (const result of session) {
          seen.push(result.counts.total);
          if (seen.length === 2) break;
        }
      })();

      await session.rerun();
      await consume;

      assert.deepEqual(seen, [3, 3], 'the initial run and the rerun both arrive');
    });
  });

  test('close() is idempotent and ends the iteration', async (assert) => {
    await withWatch({ inputs: [PASSING] }, async (session) => {
      await session.close();
      await session.close();

      const seen: number[] = [];
      for await (const result of session) seen.push(result.counts.total);

      assert.deepEqual(seen, [3], 'the queued initial result still drains, then it ends');
    });
  });
});

module('API | watch | reruns', { concurrency: true }, () => {
  test('a save produces a fresh result on the iterator', async (assert) => {
    // The whole feature, end to end: a file inside the watched tree changes on disk, the watcher
    // notices, the bundle is rebuilt, and the new result arrives on the session's iteration.
    await using project = outputDir('api-watch-project');
    const testFile = path.join(project.path, 'sample-test.ts');
    await fs.mkdir(project.path, { recursive: true });
    await fs.writeFile(testFile, GREEN_TEST);

    await withWatch({ inputs: [testFile] }, async (session) => {
      assert.equal(session.initial.counts.total, 1, 'the fixture registers one test');
      assert.true(session.initial.ok, 'and starts green');

      const iterator = session[Symbol.asyncIterator]();
      await iterator.next(); // the initial run, already queued
      const afterSave = iterator.next();

      await fs.writeFile(testFile, RED_TEST);
      const { value } = await afterSave;

      assert.false(value.ok, 'the rerun ran the edited file');
      assert.equal(value.counts.failed, 1);
      assert.true(session.initial.ok, 'and the initial result is not retroactively changed');
    });
  });

  test('rerun() picks up an edit rather than replaying the cached bundle', async (assert) => {
    await using project = outputDir('api-watch-manual');
    const testFile = path.join(project.path, 'sample-test.ts');
    await fs.mkdir(project.path, { recursive: true });
    await fs.writeFile(testFile, GREEN_TEST);

    await withWatch({ inputs: [testFile] }, async (session) => {
      assert.true(session.initial.ok);

      await fs.writeFile(testFile, RED_TEST);
      const afterEdit = await session.rerun();

      assert.false(afterEdit.ok, 'an explicit rerun rebuilds too');
      assert.equal(afterEdit.counts.failed, 1);
    });
  });
});
