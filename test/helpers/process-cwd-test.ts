import { module, test } from 'qunitx';
import fs from 'node:fs/promises';

// `deno test --parallel` runs test modules as workers inside ONE process, and the working
// directory is per-process — so a chdir in any module moves the cwd of every module running at
// the time, and every child they spawn inherits it. Under `node --test`, where each file gets its
// own process, the same line is harmless; the deno lanes are the only ones that see it, and they
// see it as an unrelated file failing (CI run 35944599684: `qunitx repl` started in a temp
// directory and exited on ProjectRootNotFound, because find-project-root-test.ts was mid-chdir).
//
// Nothing in a test needs it: `findProjectRoot(cwd)` takes the directory, and `execute`/`spawn`
// take a per-child `cwd` option, which is process-safe by construction.
const CHDIR = /(?:\bprocess|\bDeno)\.chdir\s*\(/;
// A line that only talks about it — the comment above, the reproduction recipe recorded in
// daemon-silence-test.ts — is not a call. Matching the call syntax and skipping commented lines
// keeps the check honest without teaching it JavaScript.
const COMMENT = /^\s*(?:\/\/|\*|\/\*)/;

module('Helpers | the working directory', { concurrency: true }, () => {
  test('no test moves it — a per-child cwd or an explicit argument instead', async (assert) => {
    const offenders: string[] = [];
    let scanned = 0;
    for await (const file of fs.glob('test/**/*.ts')) {
      if (file.endsWith('process-cwd-test.ts')) continue; // its own examples, below
      scanned += 1;
      const lines = (await fs.readFile(file, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        if (CHDIR.test(line) && !COMMENT.test(line)) offenders.push(`${file}:${index + 1}`);
      });
    }

    assert.true(scanned > 50, `the glob still finds the suite (scanned ${scanned} files)`);
    assert.deepEqual(
      offenders,
      [],
      'chdir is process-wide and deno runs modules in one process — pass the directory instead',
    );
  });

  test('the check reads a call, not a mention of one', (assert) => {
    const calls = ['process.chdir(dir);', '  Deno.chdir(dir);', 'await x(); process.chdir(a);'];
    const mentions = ['// needs process.chdir(), because the socket path', ' * Deno.chdir(dir)'];

    calls.forEach((line) => assert.true(CHDIR.test(line) && !COMMENT.test(line), line));
    mentions.forEach((line) => assert.true(COMMENT.test(line), line));
  });
});
