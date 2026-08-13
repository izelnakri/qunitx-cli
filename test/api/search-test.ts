import { module, test } from 'qunitx';
import * as QUnitX from '../../lib/api/index.ts';
import '../helpers/custom-asserts.ts';

const NESTED = 'test/fixtures/nested-module-tests.ts';
const PASSING = 'test/fixtures/passing-tests.ts';
// Parses cleanly but declares no test the scan can see — the `silent` half of `unlistable`.
const SILENT = 'test/fixtures/no-tests.ts';

// No browser and no bundle: `search` parses declarations, so these tests take no semaphore
// permit and run in milliseconds.

module('API | search', { concurrency: true }, () => {
  test('lists every test with a location you can pass straight back in', async (assert) => {
    const result = await QUnitX.search({ inputs: [PASSING] });

    assert.equal(result.matches.length, 3);
    assert.equal(result.total, 3);
    assert.equal(result.files, 1);
    assert.true(
      result.matches.every((one) => one.file.endsWith('passing-tests.ts') && one.line > 0),
      'each carries an absolute file and a 1-based line',
    );
  });

  test('a filter narrows the matches without changing the total', async (assert) => {
    const result = await QUnitX.search({ inputs: [PASSING], filter: 'assert true works' });

    assert.equal(result.matches.length, 1, 'matched');
    assert.equal(result.total, 3, 'out of every listable test in the file');
    assert.equal(result.filter, 'assert true works');
  });

  test('nested modules come back as a path, not a joined string', async (assert) => {
    const result = await QUnitX.search({ inputs: [NESTED] });
    const nested = result.matches.find((one) => one.modules.length > 1);

    assert.ok(nested, 'the fixture declares a nested module');
    assert.includes(nested!.fullName, nested!.modules.join(' > '));
    assert.includes(nested!.fullName, nested!.name);
  });

  test('a filter matching nothing is an empty list, not a failure', async (assert) => {
    const result = await QUnitX.search({ inputs: [PASSING], filter: 'no-such-test' });

    assert.deepEqual(result.matches, []);
    assert.equal(result.total, 3, 'the scan still reports what is there');
  });

  test('what search finds is what a run would select', async (assert) => {
    // The point of the preview: same scanner, same matcher, same answer. Verified against a real
    // run in test/flags/search-test.ts; here it is the API surface reporting the same selection.
    const previewed = await QUnitX.search({ inputs: [PASSING], filter: 'works' });
    const everything = await QUnitX.search({ inputs: [PASSING] });

    assert.deepEqual(
      previewed.matches.map((one) => one.fullName),
      everything.matches.filter((one) => one.fullName.includes('works')).map((one) => one.fullName),
    );
  });

  test('what could not be listed is broken out by cause, not just totalled', async (assert) => {
    const silent = await QUnitX.search({ inputs: [SILENT] });

    assert.equal(silent.total, 0, 'the scan saw no test it could name');
    assert.deepEqual(
      silent.unlistable,
      { total: 1, computedNames: 0, unparseable: 0, silent: 1 },
      'one silent file — told apart from a computed name or a file that would not parse',
    );

    const clean = await QUnitX.search({ inputs: [PASSING] });

    assert.equal(clean.unlistable.total, 0, 'nothing unlistable in a file the scan understands');
  });

  test('a bare string and a bare array are both input shorthands', async (assert) => {
    // The shorthand `run('test/')` / `run(['a.ts'])` expands inside `Options.from`, so it is only
    // observable from a verb. Asserted here rather than on a helper, because this is the promise.
    const [fromString, fromArray, fromObject] = await Promise.all([
      QUnitX.search(PASSING),
      QUnitX.search([PASSING]),
      QUnitX.search({ inputs: [PASSING] }),
    ]);
    const names = (result: QUnitX.SearchResult) => result.matches.map((one) => one.fullName);

    assert.equal(fromString.total, 3, 'a bare string scanned the file');
    assert.deepEqual(names(fromString), names(fromObject), 'string === { inputs }');
    assert.deepEqual(names(fromArray), names(fromObject), 'array === { inputs }');
  });

  test('an invalid option is rejected here too', async (assert) => {
    const outcome = await QUnitX.search({ browser: 'netscape' as 'chromium' }).result();

    assert.equal(QUnitX.Failure.is(outcome) ? outcome.code : null, 'InvalidOption');
  });
});
