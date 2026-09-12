import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import '../helpers/custom-asserts.ts';

// Guards against "wrote a Chromium-only test and filed it under test/flags/": `test:browser` is
// what the browser-compat matrix runs, and those runners install ONLY the browser they are testing
// — no Chromium anywhere. A test that pins `--browser=chromium` there asks for a browser that is
// not on the machine, and every firefox and webkit lane goes red on it.
const repoRoot = process.cwd();
// The `<globs>` of `node test/runner.ts <globs>`, so this reads whatever the script says today.
const SCOPE = /^\S+\s+\S*test\/runner\.ts\s+(.*)$/;
const PINS_A_BROWSER = /--browser=(?!\$)(\w+)|QUNITX_BROWSER:\s*'(\w+)'/g;

/** Every file `test:browser` would run, from the script itself rather than a second list of it. */
async function inTheMatrix(): Promise<string[]> {
  const scripts = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'),
  ).scripts;
  const globs = SCOPE.exec(scripts['test:browser'])?.[1].split(/\s+/) ?? [];
  const found = await Promise.all(
    globs.map(async (glob) => {
      const directory = path.dirname(glob);
      const names = await fs.readdir(path.join(repoRoot, directory)).catch(() => []);

      return names
        .filter((name) => name.endsWith('-test.ts'))
        .map((name) => `${directory}/${name}`);
    }),
  );

  return found.flat();
}

module('Setup | browser-compat matrix scope', { concurrency: true }, () => {
  test('nothing in the matrix asks for a browser the matrix does not install', async (assert) => {
    const files = await inTheMatrix();
    assert.true(files.length > 0, 'the scope was read from package.json, not guessed at');

    const pinned: string[] = [];
    for (const file of files) {
      const source = await fs.readFile(path.join(repoRoot, file), 'utf8');
      for (const [, flag, env] of source.matchAll(PINS_A_BROWSER)) {
        pinned.push(`${file} pins ${flag ?? env}`);
      }
    }

    assert.deepEqual(
      pinned,
      [],
      'a test that only works on one engine belongs beside its feature (test/commands/), ' +
        'not in the matrix that runs every engine',
    );
  });
});
