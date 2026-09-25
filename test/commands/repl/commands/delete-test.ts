import { module, test } from 'qunitx';
import { command as remove } from '../../../../lib/commands/repl/commands/delete.ts';
import { apiServer } from '../../../helpers/api-server.ts';
import { replContext, saidAll } from '../../../helpers/repl-context.ts';
import '../../../helpers/custom-asserts.ts';

import type { ReplContext } from '../../../../lib/commands/repl/command.ts';

// `.delete` is one name with two jobs, exactly as `.break` is: a breakpoint has a NUMBER and a
// URL never does, so the form settles which was meant. These are the tests that keep that true.

module('Commands | repl | .delete', { concurrency: true }, () => {
  test('a number is a breakpoint, and it is the debugger that is asked', async (assert) => {
    const it = replContext();
    const asked: number[] = [];
    withBreakpoints(it.repl, (index) => {
      asked.push(index);

      return true;
    });
    await remove.main(it.repl, '1');

    assert.deepEqual(asked, [1]);
    assert.strictEqual(it.printed.length, 0, 'a breakpoint that went says nothing');
  });

  test('a breakpoint that is not there is named', async (assert) => {
    const it = replContext();
    withBreakpoints(it.repl, () => false);
    await remove.main(it.repl, '7');

    assert.includes(saidAll(it.printed), 'No breakpoint 7');
  });

  test('anything that is not a number is an address, and it is sent', async (assert) => {
    await using api = await apiServer();
    const it = replContext();
    withBreakpoints(it.repl, () => true);
    await remove.main(it.repl, `${api.url}/api/users/1`);

    assert.strictEqual(it.http.requests.length, 1, 'the debugger was not involved');
    assert.strictEqual(it.http.requests[0]?.request.verb, 'DELETE');
    assert.includes(saidAll(it.printed), `DELETE ${api.url}/api/users/1`);
    assert.includes(saidAll(it.printed), '200 OK', 'and the answer was printed');
    assert.includes(saidAll(it.printed), '"deleted": 1', 'by the API, which says what it did');
  });

  test('a path is an address too, resolved against the page like every other verb', async (assert) => {
    await using api = await apiServer();
    const it = replContext({ page: `${api.url}/index.html` });
    withBreakpoints(it.repl, () => true);
    await remove.main(it.repl, '/api/users/1');

    assert.strictEqual(it.http.requests[0]?.request.url, `${api.url}/api/users/1`);
  });

  test('bare, it says both jobs rather than only the older one', async (assert) => {
    const it = replContext();
    withBreakpoints(it.repl, () => true);
    await remove.main(it.repl, '');
    const said = saidAll(it.printed);

    assert.includes(said, 'breakpoint number');
    assert.includes(said, '<url>', 'and the other thing it does');
  });

  test('zero is still a number, so it is still the breakpoint spelling', async (assert) => {
    const it = replContext();
    withBreakpoints(it.repl, () => true);
    await remove.main(it.repl, '0');

    assert.includes(saidAll(it.printed), 'Usage:', 'breakpoints are numbered from one');
    assert.strictEqual(it.http.requests.length, 0, 'and nothing was sent anywhere');
  });
});

/** The one method of a session `.delete`'s older half reaches for. */
function withBreakpoints(repl: ReplContext, answer: (index: number) => boolean): void {
  (
    repl.session as unknown as { removeBreakpoint: (index: number) => Promise<boolean> }
  ).removeBreakpoint = (index: number) => Promise.resolve(answer(index));
}
