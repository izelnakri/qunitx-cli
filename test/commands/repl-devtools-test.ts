import process from 'node:process';
import { module, test } from 'qunitx';
import { execute } from '../helpers/shell.ts';
import '../helpers/custom-asserts.ts';

/** What a session said on the way in, and what its own server answered while it was up. */
async function session(port: number): Promise<{ said: string; status: number; location: string }> {
  const answered = { said: '', status: 0, location: '' };
  const running = execute(`node cli.ts repl --browser=chromium --port=${port}`, {
    // `.exit` only once the banner has appeared: on a loaded runner a browser takes as long as it
    // takes, and a fixed wait would close the session before anything could knock on it.
    stdin: [
      { text: '.devtools\n', after: /type `\.help` for commands/ },
      { text: '.exit\n', delayMs: 3000 },
    ],
  });
  // Knocked on until it answers something final: the port binds before the browser is up, and
  // "still starting" is the route working rather than the answer being asked for.
  for (let waited = 0; waited < 25_000; waited += 250) {
    const response = await fetch(`http://localhost:${port}/devtools`, { redirect: 'manual' }).catch(
      () => null,
    );
    if (response) {
      answered.status = response.status;
      answered.location = response.headers.get('location') ?? '';
      const body = await response.text();
      if (!body.includes('still starting')) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  answered.said = (await running).stdout;

  return answered;
}

// Chrome serves its own DevTools frontend over the same debugging port the session drives the page
// on. Handing that out means any Chromium browser can open the REPL's OWN page — one realm, two
// views — which is the thing `--open` does with a window and this does without one.
//
// It needs the Chrome this process pre-launched, and there are machines with none: macOS, where
// nothing is pre-launched, and any runner that installed only the browser it is testing. So what is
// asserted is the invariant rather than the environment — the address is offered exactly when
// opening it would work — which is the promise a banner makes and the one worth keeping.
module('Flags | repl | /devtools', { concurrency: true }, () => {
  test('the address is offered exactly when opening it would work', async (assert) => {
    const { said, status, location } = await session(18287);
    const offered = said.includes('inspect the same page at http://localhost:18287/devtools');

    if (offered) {
      const parts =
        /^http:\/\/localhost:(\d+)\/devtools\/inspector\.html\?ws=localhost:(\d+)$/.exec(location);

      assert.strictEqual(status, 302, 'a redirect, so the address stays the one you were given');
      assert.true(parts !== null, `Chrome's own frontend, pointed at a socket — got ${location}`);
      // The socket is NOT Chrome's own: a browser sends an Origin header, and Chrome answers 403
      // to any debugger connection that has one.
      assert.notStrictEqual(parts?.[2], parts?.[1], 'the frontend connects through the bridge');
      assert.includes(said, 'http://localhost:18287/devtools\n', '`.devtools` answers the same');
    } else {
      assert.strictEqual(status, 503, 'nothing is promised, and asking says so rather than 404');
      assert.includes(said, 'no debugging endpoint here', 'and `.devtools` says why');
    }
  });

  if (process.platform === 'darwin') {
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
  }
});
