import { module, test } from 'qunitx';
import { assertPassingTestCase, assertTAPResult } from '../helpers/custom-asserts.js';
import { shellWatch } from '../helpers/shell.js';

module('--watch flag tests', () => {
  test('--watch runs tests, starts the server, and prints watching info', async (assert) => {
    const stdout = await shellWatch('node cli.js test/helpers/passing-tests.js --watch', {
      until: (buf) => buf.includes('Press "qq"'),
    });

    assertPassingTestCase(assert, stdout, { moduleName: '{{moduleName}}' });
    assertTAPResult(assert, stdout, { testCount: 3 });
    assert.includes(stdout, 'Watching files...');
    assert.includes(stdout, 'http://localhost:');
    assert.includes(stdout, 'Press "qq"');
    assert.includes(stdout, '"qa"');
    assert.includes(stdout, '"qf"');
    assert.includes(stdout, '"ql"');
  });
});
