import { module, test } from 'qunitx';
import '../helpers/custom-asserts.js';
import shell, { shellFails } from '../helpers/shell.js';

module('Advanced Error Edge Cases Tests', (_hooks, moduleMetadata) => {
  test('passing a non-existent file path exits with code 1', async (assert, testMetadata) => {
    const cmd = await shellFails('node cli.js tmp/this-file-does-not-exist.js', {
      ...moduleMetadata,
      ...testMetadata,
      noSemaphore: true,
    });
    assert.exitCode(cmd, 1);
  });

  test('passing a non-existent folder path exits with code 1', async (assert, testMetadata) => {
    const cmd = await shellFails('node cli.js tmp/this-folder-does-not-exist', {
      ...moduleMetadata,
      ...testMetadata,
      noSemaphore: true,
    });
    assert.exitCode(cmd, 1);
  });

  // There is no explicit "unknown command" handler in cli.js — unrecognised arguments
  // are treated as file/folder inputs. An arg that maps to a non-existent path therefore
  // exits 1, the same as passing a missing file explicitly.
  test('passing an unrecognised argument is treated as a missing path and exits with code 1', async (assert, testMetadata) => {
    const cmd = await shellFails('node cli.js this-command-does-not-exist', {
      ...moduleMetadata,
      ...testMetadata,
      noSemaphore: true,
    });
    assert.exitCode(cmd, 1);
  });
});
