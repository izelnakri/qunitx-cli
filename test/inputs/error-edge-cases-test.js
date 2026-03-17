import { module, test } from 'qunitx';
import shell from '../helpers/shell.js';

module('Advanced Error Edge Cases Tests', (_hooks, moduleMetadata) => {
  test('passing a non-existent file path exits with code 1', async (assert, testMetadata) => {
    try {
      await shell('node cli.js tmp/this-file-does-not-exist.js', {
        ...moduleMetadata,
        ...testMetadata,
      });
      assert.ok(false, 'expected a non-zero exit code for a missing file');
    } catch (cmd) {
      assert.ok(cmd.code === 1, `expected exit code 1, got ${cmd.code}`);
    }
  });

  test('passing a non-existent folder path exits with code 1', async (assert, testMetadata) => {
    try {
      await shell('node cli.js tmp/this-folder-does-not-exist', {
        ...moduleMetadata,
        ...testMetadata,
      });
      assert.ok(false, 'expected a non-zero exit code for a missing folder');
    } catch (cmd) {
      assert.ok(cmd.code === 1, `expected exit code 1, got ${cmd.code}`);
    }
  });

  // There is no explicit "unknown command" handler in cli.js — unrecognised arguments
  // are treated as file/folder inputs. An arg that maps to a non-existent path therefore
  // exits 1, the same as passing a missing file explicitly.
  test('passing an unrecognised argument is treated as a missing path and exits with code 1', async (assert, testMetadata) => {
    try {
      await shell('node cli.js this-command-does-not-exist', {
        ...moduleMetadata,
        ...testMetadata,
      });
      assert.ok(false, 'expected a non-zero exit code for an unrecognised argument');
    } catch (cmd) {
      assert.ok(cmd.code === 1, `expected exit code 1, got ${cmd.code}`);
    }
  });
});
