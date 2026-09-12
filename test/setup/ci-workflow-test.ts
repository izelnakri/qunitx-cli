import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import '../helpers/custom-asserts.ts';

// What CI runs has to match what this repo declares, and nothing but a test can say so: a
// workflow is only ever exercised by pushing to it, and both of these went wrong that way.
//
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

/** Every `- run:` in one job of a workflow, in order. */
async function stepsOf(workflow: string, job: string): Promise<string[]> {
  const yaml = await fs.readFile(path.join(repoRoot, '.github/workflows', workflow), 'utf8');
  // From this job's key to the next one at the same indent — enough of a parser for `- run:`
  // lines, and a dependency-free one.
  const block = new RegExp(`^  ${job}:$([\\s\\S]*?)(?=^  \\S+:$)`, 'm').exec(yaml)?.[1] ?? '';

  return [...block.matchAll(/^\s+- run: (.+)$/gm)].map(([, command]) => command.trim());
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

// The lint job is spelled out step by step so the Actions UI names the check that failed, and
// `npm run verify` is that same list for a contributor. Two copies of one list is the price of
// that readability; this is what stops them drifting, which is the only thing a single
// `- run: npm run verify` step was ever protecting.
module('Setup | the lint job and `npm run verify`', { concurrency: true }, () => {
  test('run the same checks, in the same order', async (assert) => {
    const scripts = JSON.parse(
      await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'),
    ).scripts;
    const verify = scripts.verify.split('&&').map((command: string) => command.trim());
    // `npm ci` installs, it does not check — it is the job's setup, not part of the list.
    const job = (await stepsOf('ci.yml', 'lint')).filter((command) => command !== 'npm ci');

    assert.true(verify.length > 1, 'the list was read from package.json, not guessed at');
    assert.deepEqual(
      job,
      verify,
      'add the check to both, or to `verify` and then to .github/workflows/ci.yml',
    );
  });
});
