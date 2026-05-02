import { module, test } from 'qunitx';
import '../helpers/custom-asserts.ts';
import { shellFails } from '../helpers/shell.ts';

module('Advanced Error Edge Cases Tests', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('passing a non-existent file path exits with code 1', async (assert, testMetadata) => {
    const cmd = await shellFails('node cli.ts tmp/this-file-does-not-exist.js', {
      ...moduleMetadata,
      ...testMetadata,
    });
    assert.exitCode(cmd, 1);
  });

  test('passing a non-existent folder path exits with code 1', async (assert, testMetadata) => {
    const cmd = await shellFails('node cli.ts tmp/this-folder-does-not-exist', {
      ...moduleMetadata,
      ...testMetadata,
    });
    assert.exitCode(cmd, 1);
  });

  // There is no explicit "unknown command" handler in cli.ts — unrecognised arguments
  // are treated as file/folder inputs. An arg that maps to a non-existent path therefore
  // exits 1, the same as passing a missing file explicitly.
  test('passing an unrecognised argument is treated as a missing path and exits with code 1', async (assert, testMetadata) => {
    const cmd = await shellFails('node cli.ts this-command-does-not-exist', {
      ...moduleMetadata,
      ...testMetadata,
    });
    assert.exitCode(cmd, 1);
  });
});
