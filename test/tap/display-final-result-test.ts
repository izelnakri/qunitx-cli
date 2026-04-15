import { module, test } from 'qunitx';
import TAPDisplayFinalResult from '../../lib/tap/display-final-result.ts';
import '../helpers/custom-asserts.ts';
import { captureStdout } from '../helpers/capture-stdout.ts';

module('TAP | TAPDisplayFinalResult | output', { concurrency: true }, () => {
  test('emits plan line, all summary lines, and duration', (assert) => {
    const output = captureStdout(() => {
      TAPDisplayFinalResult(
        { testCount: 5, passCount: 3, skipCount: 1, todoCount: 1, failCount: 1, errorCount: 1 },
        2345,
      );
    });
    assert.includes(output, '1..5\n', 'plan line must be present');
    assert.includes(output, '# tests 5\n');
    assert.includes(output, '# pass 3\n');
    assert.includes(output, '# skip 1\n');
    assert.includes(output, '# todo 1\n');
    assert.includes(output, '# fail 1\n');
    assert.includes(output, '# duration 2345\n');
  });

  test('output starts and ends with a blank line', (assert) => {
    const output = captureStdout(() => {
      TAPDisplayFinalResult(
        { testCount: 1, passCount: 1, skipCount: 0, todoCount: 0, failCount: 0, errorCount: 0 },
        100,
      );
    });
    assert.true(output.startsWith('\n'), 'output must start with a blank line');
    assert.true(output.endsWith('\n\n'), 'output must end with a blank line');
  });

  test('lines appear in the correct order', (assert) => {
    const output = captureStdout(() => {
      TAPDisplayFinalResult(
        { testCount: 3, passCount: 2, skipCount: 0, todoCount: 0, failCount: 1, errorCount: 1 },
        500,
      );
    });
    const idx = (s: string) => output.indexOf(s);
    assert.true(idx('1..3') < idx('# tests 3'), 'plan before # tests');
    assert.true(idx('# tests 3') < idx('# pass 2'), '# tests before # pass');
    assert.true(idx('# pass 2') < idx('# skip 0'), '# pass before # skip');
    assert.true(idx('# skip 0') < idx('# todo 0'), '# skip before # todo');
    assert.true(idx('# todo 0') < idx('# fail 1'), '# todo before # fail');
    assert.true(idx('# fail 1') < idx('# duration 500'), '# fail before # duration');
  });

  test('all-passing run shows # fail 0', (assert) => {
    const output = captureStdout(() => {
      TAPDisplayFinalResult(
        { testCount: 10, passCount: 10, skipCount: 0, todoCount: 0, failCount: 0, errorCount: 0 },
        1000,
      );
    });
    assert.includes(output, '# fail 0\n');
    assert.includes(output, '# pass 10\n');
    assert.includes(output, '1..10\n');
  });

  test('zero-test run emits plan "1..0"', (assert) => {
    const output = captureStdout(() => {
      TAPDisplayFinalResult(
        { testCount: 0, passCount: 0, skipCount: 0, todoCount: 0, failCount: 0, errorCount: 0 },
        0,
      );
    });
    assert.includes(output, '1..0\n');
    assert.includes(output, '# tests 0\n');
  });
});
