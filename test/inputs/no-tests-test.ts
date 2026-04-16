import { module, test } from 'qunitx';
import execute from '../helpers/shell.ts';
import { shellWatch } from '../helpers/shell.ts';
import '../helpers/custom-asserts.ts';

const CLI = `node cli.ts`;
const CWD = process.cwd();

// A fixture file that is valid TypeScript but registers no QUnit tests.
// Also covers the case of a file that doesn't import qunitx at all — both should produce
// the "0 tests registered" warning rather than a TIMEOUT failure.
const NO_TESTS_FIXTURE = `${CWD}/test/fixtures/no-tests.ts`;

module('No-tests warning', { concurrency: true }, () => {
  test('exits 0 and prints a warning when the test file has no QUnit test registrations', async (assert) => {
    const result = await execute(`${CLI} ${NO_TESTS_FIXTURE}`);
    assert.includes(result, '# Warning: 0 tests registered');
    assert.notIncludes(result, 'TIMEOUT');
    assert.notIncludes(result, 'BROWSER: runtime error');
    assert.includes(result, '# tests 0');
    assert.includes(result, '# fail 0');
  });

  test('no-tests warning appears in watch mode too and watcher stays alive', async (assert) => {
    // In watch mode, 0 tests is a warning, not a crash. The watcher should stay alive
    // so the user can add tests and see them run.
    const result = await shellWatch(`${CLI} ${NO_TESTS_FIXTURE} --watch`, {
      until: (buf) => buf.includes('Watching files'),
    });
    assert.includes(result, '# Warning: 0 tests registered');
    assert.includes(result, 'Watching files');
    assert.notIncludes(result, 'TIMEOUT');
  });
});
