import { module, test } from 'qunitx';
import '../helpers/custom-asserts.ts';
import { shellWatch } from '../helpers/shell.ts';

module('--watch flag tests', () => {
  test('--watch runs tests, starts the server, and prints watching info', async (assert) => {
    const stdout = await shellWatch('node cli.ts test/helpers/passing-tests.ts --watch', {
      until: (buf) => buf.includes('Press "qq"'),
    });

    assert.passingTestCaseFor(stdout, { moduleName: '{{moduleName}}' });
    assert.tapResult(stdout, { testCount: 3 });
    assert.includes(stdout, 'Watching files...');
    assert.includes(stdout, 'http://localhost:');
    assert.includes(stdout, 'Press "qq"');
    assert.includes(stdout, '"qa"');
    assert.includes(stdout, '"qf"');
    assert.includes(stdout, '"ql"');
  });
});
