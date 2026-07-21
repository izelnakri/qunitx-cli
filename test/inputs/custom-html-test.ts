import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { rmRetry } from '../helpers/rm-retry.ts';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import '../helpers/custom-asserts.ts';
import { execute as shell, shellWatch } from '../helpers/shell.ts';

const CLI = path.resolve('cli.ts');

module('Inputs | custom html template', { concurrency: true }, () => {
  // The CLI is invoked from the generated project rather than the repo, so both tests go
  // through the harness's cwd option — which is also what forwards --browser in the
  // browser-compat lanes.
  test('serves the suite from a passed custom.html that uses handlebars-style syntax', async (assert) => {
    const { dir, id } = await makeCustomHTMLProject();

    try {
      const result = await shell(`node ${CLI} tests/passing-tests.ts custom.html`, { cwd: dir });

      assert.includes(result, 'QUnitX running: http://localhost:');
      assert.includes(result, '/custom.html');
      assert.passingTestCaseFor(result, { moduleName: id });
      assert.tapResult(result, { testCount: 3 });
    } finally {
      await rmRetry(dir);
    }
  });

  test('serves the same custom.html in watch mode and keeps watching', async (assert) => {
    const { dir, id } = await makeCustomHTMLProject();

    try {
      const stdout = await shellWatch(`node ${CLI} tests/passing-tests.ts custom.html --watch`, {
        cwd: dir,
        until: (buf) => buf.includes('Press "qq"'),
      });

      assert.includes(stdout, 'QUnitX running: http://localhost:');
      assert.includes(stdout, '/custom.html');
      assert.passingTestCaseFor(stdout, { moduleName: id });
      assert.tapResult(stdout, { testCount: 3 });
      assert.includes(stdout, 'Watching files...');
    } finally {
      await rmRetry(dir);
    }
  });
});

async function makeCustomHTMLProject() {
  const id = randomUUID();
  const dir = path.resolve(`tmp/custom-html-${id}`);
  const testsDir = `${dir}/tests`;
  await fs.mkdir(testsDir, { recursive: true });

  const [template] = await Promise.all([
    fs.readFile(path.resolve('test/fixtures/passing-tests.ts'), 'utf8'),
    fs.writeFile(
      `${dir}/package.json`,
      JSON.stringify({ name: id, version: '0.0.1', type: 'module' }, null, 2),
    ),
    fs.symlink(path.resolve('node_modules'), `${dir}/node_modules`),
  ]);

  await Promise.all([
    fs.writeFile(`${testsDir}/passing-tests.ts`, template.replace('{{moduleName}}', id)),
    fs.writeFile(
      `${dir}/custom.html`,
      `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${id}</title>
    <link href="./node_modules/qunitx/vendor/qunit.css" rel="stylesheet">
  </head>
  <body>
    <section data-template="{{pageShell}}"></section>
  </body>
</html>`,
    ),
  ]);

  return { dir, id };
}
