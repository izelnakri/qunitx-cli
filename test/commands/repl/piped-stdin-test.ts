import { module, test } from 'qunitx';
import { Readable } from 'node:stream';
import { linesOf } from '../../../lib/commands/repl/index.ts';

// A piped `qunitx repl` reads its lines only once the browser is up, seconds after it starts. An
// empty stdin can reach EOF before that — Deno on Windows ends it that early — and readline, which
// waits for an `end` that has already been emitted, then waited forever: the session never closed.
module('Commands | repl | reading a piped stdin', { concurrency: true }, () => {
  test('a stream that ended before it was read yields nothing, and finishes', async (assert) => {
    const source = new Readable({ read() {} });
    source.push(null);
    source.resume();
    await new Promise((resolve) => source.on('end', resolve));

    const lines: string[] = [];
    const read = (async () => {
      for await (const line of linesOf(source)) lines.push(line);
      return 'finished';
    })();
    // The bug is a hang, so it is raced rather than left to the suite's 300s timeout. Finishing is
    // a matter of microtasks; the second only has to be longer than never.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stuck = new Promise((resolve) => {
      timer = setTimeout(resolve, 1000, 'still waiting');
    });
    const outcome = await Promise.race([read, stuck]);
    clearTimeout(timer);

    assert.strictEqual(outcome, 'finished', 'not waiting on an end that was already emitted');
    assert.deepEqual(lines, []);
  });

  test('a live stream yields its lines in order', async (assert) => {
    const lines: string[] = [];
    for await (const line of linesOf(Readable.from(['1 + 1\n', "'hi'\n"]))) lines.push(line);

    assert.deepEqual(lines, ['1 + 1', "'hi'"]);
  });
});
