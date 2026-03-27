import { module, test } from 'qunitx';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import '../helpers/custom-asserts.ts';

const exec = promisify(execCb);
const CLI = path.resolve('cli.ts');

module('Commands | init tests', (_hooks, moduleMetadata) => {
  test('$ qunitx init -> writes test/tests.html, tsconfig.json and updates package.json', async (assert) => {
    const dir = path.resolve(`tmp/init-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${dir}/package.json`, JSON.stringify({ name: 'test-project' }, null, 2));

    try {
      const { stdout } = await exec(`node --experimental-strip-types ${CLI} init`, { cwd: dir });

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
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('$ qunitx init -> exits with code 1 and prints an error when no package.json is found', async (assert) => {
    const dir = `/tmp/qunitx-init-${randomUUID()}`;
    await fs.mkdir(dir, { recursive: true });

    try {
      const error = await exec(`node --experimental-strip-types ${CLI} init`, { cwd: dir }).catch(
        (e) => e,
      );

      assert.exitCode(error, 1, 'exits with code 1 when no package.json found');
      assert.ok(error.stdout.includes('package.json'), 'prints error about missing package.json');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('$ qunitx init -> prints "already exists" and does not overwrite an existing html file', async (assert) => {
    const dir = path.resolve(`tmp/init-${randomUUID()}`);
    await fs.mkdir(`${dir}/test`, { recursive: true });
    await Promise.all([
      fs.writeFile(`${dir}/package.json`, JSON.stringify({ name: 'test-project' }, null, 2)),
      fs.writeFile(`${dir}/test/tests.html`, '<!-- original content -->'),
    ]);

    try {
      const { stdout } = await exec(`node --experimental-strip-types ${CLI} init`, { cwd: dir });

      assert.includes(stdout, 'already exists', 'reports existing html file');

      const content = await fs.readFile(`${dir}/test/tests.html`, 'utf8');
      assert.equal(content, '<!-- original content -->', 'existing html file was not overwritten');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
