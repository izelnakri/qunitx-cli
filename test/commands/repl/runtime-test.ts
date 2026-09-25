import { module, test } from 'qunitx';
import { execute, shellFails } from '../../helpers/shell.ts';
import { RUNTIMES } from '../../../lib/setup/targets.ts';
import '../../helpers/custom-asserts.ts';

/** The prompt, on a runtime, fed a script and asked what it said. */
const repl = (runtime: string, stdin: string, args = '') =>
  execute(`node cli.ts repl --browser=${runtime} ${args}`.trim(), { stdin: `${stdin}\n.exit\n` });

for (const runtime of RUNTIMES) {
  module(`Commands | repl | on ${runtime}`, () => {
    test('it is the same prompt, in a process with no page in it', async (assert) => {
      const result = await repl(runtime, ['1 + 1', 'typeof window', 'typeof document'].join('\n'));

      assert.includes(result, '2');
      assert.includes(result, `evaluating in ${runtime}`);
      // The whole difference, in one line: there is no page here, and the prompt does not pretend.
      assert.includes(result, "'undefined'", 'window and document are simply not there');
    });

    test('a declaration reaches the next line, which is what makes it a prompt', async (assert) => {
      const result = await repl(runtime, ['const user = { name: "Izel" }', 'user.name'].join('\n'));

      assert.includes(result, "'Izel'");
    });

    // The part that needed a spike: `qunitx`'s node and deno builds register with `node:test` and
    // `Deno.test`, neither of which hands out a queue to flush on demand. Its BROWSER build needs
    // no DOM, so that is the one a runtime session loads.
    test('tests registered at the prompt run, and report as TAP', async (assert) => {
      const result = await repl(
        runtime,
        [
          `module('at the prompt', () => test('two and two', (a) => a.strictEqual(2 + 2, 4)))`,
          `module('and one that fails', () => test('nope', (a) => a.strictEqual(1, 2)))`,
        ].join('\n'),
      );

      assert.includes(result, 'ok 1 at the prompt | two and two');
      assert.includes(result, 'not ok 2 and one that fails | nope');
      assert.includes(result, 'expected: 2', 'a failure still arrives with its diff');
    });

    test('a file is imported as itself, TypeScript and all — no bundler in sight', async (assert) => {
      const result = await repl(
        runtime,
        [`import { create } from './lib/repl/http-service.ts'`, 'typeof create'].join('\n'),
      );

      assert.includes(result, "'function'");
    });

    // The reason `.import` loads the real file rather than bundling it on a runtime: a bundled
    // copy is a different script to V8, so a breakpoint on the FILE would never be hit by it.
    test('a breakpoint in an imported file stops it, with its locals readable', async (assert) => {
      const result = await repl(
        runtime,
        [
          '.import test/fixtures/repl-breakable.mjs',
          '.break test/fixtures/repl-breakable.mjs:4',
          'ReplBreakable.hit()',
          '.locals',
          '.continue',
        ].join('\n'),
      );

      assert.includes(result, 'breakpoint 1 at test/fixtures/repl-breakable.mjs:4');
      assert.includes(result, 'paused at hit', 'the import actually hit it');
      assert.includes(result, 'repl-breakable.mjs:4', 'and reports the real file, not a bundle');
      assert.includes(result, 'answer', 'a stopped scope is readable');
    });

    test('a preloaded file is in scope from the first prompt', async (assert) => {
      const result = await repl(runtime, 'ReplBreakable.hit()', 'test/fixtures/repl-breakable.mjs');

      assert.includes(result, 'loaded test/fixtures/repl-breakable.mjs');
      assert.includes(result, '42');
    });

    test('there is still a URL, so a relative HTTP target still means something', async (assert) => {
      const result = await repl(runtime, ['.url'].join('\n'));

      assert.includes(result, 'http://localhost:', 'a runtime session is served, like a page one');
    });
  });
}

module('Commands | repl | a runtime is not a test run', () => {
  // Both say it on stderr, which is where a CLI says why it is not doing what was asked.
  test('`qunitx test --browser=node` says so, and does not try', async (assert) => {
    const result = await shellFails('node cli.ts test/repl/input-test.ts --browser=node');

    assert.includes(result.stderr, 'opens a prompt, not a test run');
    assert.includes(
      result.stderr,
      'qunitx repl --browser=node',
      'and names the thing that does work',
    );
  });

  test('an unknown target is still refused, and now lists five', async (assert) => {
    const result = await shellFails('node cli.ts test/repl/input-test.ts --browser=bun');

    assert.includes(result.stderr, 'chromium, firefox, webkit, node, deno');
  });
});
