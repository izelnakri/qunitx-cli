import { module, test } from 'qunitx';
import { execute } from '../helpers/shell.ts';
import '../helpers/custom-asserts.ts';

/**
 * A session held open long enough to be knocked on, and what its own server answers.
 *
 * The port is fixed per call rather than left to the auto-increment, because the whole point of
 * the route is that the address is one you already have. Knocked on until it answers rather than
 * after a fixed wait: what is being waited for is a browser starting, which has no fixed length.
 */
async function knock(
  port: number,
  path: string,
): Promise<{ status: number; location: string; served: string }> {
  const answered = { status: 0, location: '', served: '' };
  const session = execute(`node cli.ts repl --browser=chromium --port=${port}`, {
    // `.exit` only once the banner has appeared: on a loaded runner the browser takes as long as
    // it takes, and a fixed wait would close the session before anything could knock on it.
    stdin: [{ text: '.exit\n', after: /type `\.help` for commands/, delayMs: 2000 }],
  });
  // Until it is more than "still starting": the port binds before the browser is up, and both
  // answers are the route working.
  for (let waited = 0; waited < 25_000; waited += 250) {
    const response = await fetch(`http://localhost:${port}${path}`, { redirect: 'manual' }).catch(
      () => null,
    );
    if (response) {
      answered.status = response.status;
      answered.location = response.headers.get('location') ?? '';
      await response.arrayBuffer();
      if (answered.status !== 503) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // The port is only the one that was asked for if nothing else had it — said out loud so a
  // collision fails as a collision rather than as a mysteriously silent route.
  answered.served = /at (http:\/\/localhost:\d+)/.exec((await session).stdout)?.[1] ?? '';

  return answered;
}

// Chrome serves its own DevTools frontend over the same debugging port the session drives the page
// on. Handing that out means any Chromium browser can open the REPL's OWN page — one realm, two
// views — which is the thing `--open` does with a window and this does without one.
//
// It needs the Chrome this process pre-launched, which is not spawned on macOS: there the session
// falls back to a browser Playwright launched, which talks over a pipe and serves no frontend at
// all. That case has its own test below — what matters there is that nothing is offered.
module('Flags | repl | /devtools', { concurrency: true }, () => {
  if (process.platform === 'darwin') {
    test('a session with no debugging endpoint offers nothing, rather than an address that fails', async (assert) => {
      const result = await execute('node cli.ts repl --browser=chromium', { stdin: '.devtools\n' });

      assert.notIncludes(result, 'inspect the same page at', 'the banner does not promise it');
      assert.includes(result, 'no debugging endpoint here', 'and the command says why');
    });

    test('`--open` says it cannot open a window here, and carries on without one', async (assert) => {
      // A headed session on macOS dies inside the launch: playwright's headless shell is what this
      // platform falls back to, and it cannot open one. A prompt that will not start would be
      // worse than a prompt with no window.
      const result = await execute('node cli.ts repl --open --browser=chromium', {
        stdin: '1 + 1\n',
      });

      assert.exitCode(result, 0, 'the session still starts');
      assert.includes(result, '--open cannot open a window on macOS');
      assert.includes(result, '2', 'and still evaluates');
    });

    return;
  }

  test('the session offers an address on its own port, and it points at its own page', async (assert) => {
    const { status, location, served } = await knock(18287, '/devtools');

    assert.strictEqual(served, 'http://localhost:18287', 'the port it was asked for was free');
    assert.strictEqual(status, 302, 'a redirect, so the address stays the one you were given');
    const parts = /^http:\/\/localhost:(\d+)\/devtools\/inspector\.html\?ws=localhost:(\d+)$/.exec(
      location,
    );

    assert.true(parts !== null, `Chrome's own frontend, pointed at a socket — got ${location}`);
    // The socket is NOT Chrome's own: a browser sends an Origin header and Chrome answers 403 to
    // any debugger connection that has one.
    assert.notStrictEqual(parts?.[2], parts?.[1], 'the frontend connects through the bridge');
  });

  test('the banner says the address, because nobody guesses that it exists', async (assert) => {
    const result = await execute('node cli.ts repl --browser=chromium', { stdin: '.devtools\n' });
    // Whatever port this session ended up on — the point is that it is the SAME one, which is
    // what makes the address one you already have.
    const served = /at (http:\/\/localhost:\d+)/.exec(result.stdout)?.[1];

    assert.includes(result, `inspect the same page at ${served}/devtools`);
    assert.includes(result, `${served}/devtools\n`, 'and `.devtools` answers with the same one');
  });
});
