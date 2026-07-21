import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmRetry } from '../helpers/rm-retry.ts';
import { execute as shell, shellFails } from '../helpers/shell.ts';
import '../helpers/custom-asserts.ts';

// Absolute so the command still resolves after `cwd` is pointed at the throwaway project.
// The shell helper still recognises the trailing `cli.ts` and honours QUNITX_BIN, so
// scripts/test-release.sh exercises init through the published binary too. It adds no
// --output/--browser flags here: init never reaches the run path or a browser.
const CLI = path.resolve('cli.ts');

module('Commands | init', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('$ qunitx init -> writes test/tests.html, tsconfig.json and updates package.json', async (assert, testMetadata) => {
    const dir = path.resolve(`tmp/init-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${dir}/package.json`, JSON.stringify({ name: 'test-project' }, null, 2));

    try {
      const { stdout } = await shell(`node ${CLI} init`, {
        cwd: dir,
        ...moduleMetadata,
        ...testMetadata,
      });

      assert.includes(stdout, 'written', 'prints a confirmation message');

      const [htmlStat, pkgResult, tsconfigStat] = await Promise.allSettled([
        fs.stat(`${dir}/test/tests.html`),
        fs.readFile(`${dir}/package.json`, 'utf8').then(JSON.parse),
        fs.stat(`${dir}/tsconfig.json`),
      ]);

      assert.ok(htmlStat.value, 'test/tests.html was created');
      assert.ok(pkgResult.value?.qunitx, 'package.json has qunitx config');
      assert.deepEqual(
        pkgResult.value?.qunitx.htmlPaths,
        ['test/tests.html'],
        'htmlPaths defaults to test/tests.html',
      );
      assert.ok(tsconfigStat.value, 'tsconfig.json was created');
    } finally {
      await rmRetry(dir);
    }
  });

  test('$ qunitx init -> exits with code 1 and prints an error when no package.json is found', async (assert) => {
    // os.tmpdir() (not hardcoded /tmp) so the path resolves correctly on Windows where
    // /tmp would point at a non-existent D:\tmp.
    const dir = path.join(os.tmpdir(), `qunitx-init-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });

    try {
      const result = await shellFails(`node ${CLI} init`, { cwd: dir });

      assert.exitCode(result, 1, 'exits with code 1 when no package.json found');
      assert.includes(result, 'package.json', 'prints error about missing package.json');
    } finally {
      await rmRetry(dir);
    }
  });

  test('$ qunitx init -> prints "already exists" and does not overwrite an existing html file', async (assert, testMetadata) => {
    const dir = path.resolve(`tmp/init-${randomUUID()}`);
    await fs.mkdir(`${dir}/test`, { recursive: true });
    await Promise.all([
      fs.writeFile(`${dir}/package.json`, JSON.stringify({ name: 'test-project' }, null, 2)),
      fs.writeFile(`${dir}/test/tests.html`, '<!-- original content -->'),
    ]);

    try {
      const { stdout } = await shell(`node ${CLI} init`, {
        cwd: dir,
        ...moduleMetadata,
        ...testMetadata,
      });

      assert.includes(stdout, 'already exists', 'reports existing html file');

      const content = await fs.readFile(`${dir}/test/tests.html`, 'utf8');
      assert.equal(content, '<!-- original content -->', 'existing html file was not overwritten');
    } finally {
      await rmRetry(dir);
    }
  });
});
