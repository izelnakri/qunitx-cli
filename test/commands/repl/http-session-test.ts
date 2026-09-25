import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { module, test } from 'qunitx';
import { execute } from '../../helpers/shell.ts';
import { apiServer } from '../../helpers/api-server.ts';
import { tempDir } from '../../helpers/temp-dir.ts';
import '../../helpers/custom-asserts.ts';

// A piped session is the same code path a terminal drives, minus the prompt — so this is the only
// place that proves the commands are actually REGISTERED, and that a path really does reach the
// page's own server rather than a URL a unit test handed in.

const repl = (stdin: string) => execute('node cli.ts repl --browser=chromium', { stdin });

module('Commands | repl | requests in a real session', { concurrency: true }, () => {
  test('a path is the page’s own server, and the session remembers what it sent', async (assert) => {
    const result = await repl(
      '.header accept=text/plain\n.get /tests.js\n.request status\n.request list\n.exit\n',
    );

    assert.exitCode(result, 0);
    assert.includes(result, 'accept: text/plain', 'the header was saved and echoed');
    assert.regex(result, /GET http:\/\/localhost:\d+\/tests\.js/, 'resolved against the page');
    assert.includes(result, '200 OK', 'which is the suite’s own bundle, so it is there');
    // `.request list` proves the exchange outlived the command that made it. Any age: a loaded
    // runner can take a second between the two, and then it reads `1s ago`, not `just now`.
    assert.regex(
      result,
      /(just now|\d+[smh] ago)\s+#1\s+200\s+GET\s+http:\/\/localhost:\d+\/tests\.js/,
    );
  });

  test('the saved header actually rides along, which is the point of saving it', async (assert) => {
    const result = await repl('.header x-typed-here=yes\n.get /tests.js\n.header sent\n.exit\n');

    assert.exitCode(result, 0);
    assert.includes(result, 'x-typed-here: yes');
    // The session's own default, which is the page's user-agent rather than a name of ours — a
    // server that behaves differently for a robot should see what the browser would have sent.
    assert.includes(result, 'user-agent: Mozilla/5.0', 'beside the defaults a session starts with');
    assert.notIncludes(result, 'Headless', 'the word that says a robot is reading is taken out');
    assert.includes(result, 'the runtime adds', 'and it does not claim to be the whole list');
  });

  test('a body typed as JavaScript reaches an API as JSON, at a port named by itself', async (assert) => {
    // Everything a person actually types: the port without the host, and an object without the
    // quotes JSON wants. Both are decided in the session — the port in `resolveUrl`, the body by
    // the page evaluating it — so only a real session can prove either.
    await using api = await apiServer();
    const port = new URL(api.url).port;
    const result = await repl(
      `.post :${port}/api/users { name: "Izel" }\n.get :${port}/api/users/3\n.exit\n`,
    );

    assert.exitCode(result, 0);
    assert.includes(
      result,
      '201 Created',
      'the API took it, so it was JSON by the time it arrived',
    );
    assert.includes(result, `| POST http://localhost:${port}/api/users`, '`:port` is this machine');
    assert.includes(result, '"name": "Izel"', 'and the user it made is there to be read back');
  });

  test('the body buffer is one buffer: `:` opens it again with what was left in it', async (assert) => {
    if (process.platform === 'win32') {
      return assert.true(true, 'skipped: the stand-in editor is a shell script');
    }
    await using api = await apiServer();
    await using directory = await tempDir('repl-body-buffer');
    // An editor that appends one character to whatever it was given, so what comes back on the
    // second open proves the first one was kept — a stand-in for a person typing more.
    const editor = path.join(directory.path, 'append.sh');
    await fs.writeFile(
      editor,
      '#!/bin/sh\n{ cat "$1"; printf x; } > "$1.new" && mv "$1.new" "$1"\n',
    );
    await fs.chmod(editor, 0o755);
    const port = new URL(api.url).port;
    const result = await execute('node cli.ts repl --browser=chromium', {
      stdin: `.post :${port}/echo-headers :\n.post :${port}/echo-headers :\n.request 1\n.exit\n`,
      env: { ...process.env, EDITOR: editor },
    });

    assert.exitCode(result, 0);
    assert.includes(result, '\nxx\n', 'the second edit started from the first one');
  });

  test('`.delete` keeps both of its jobs in a live session', async (assert) => {
    const result = await repl('.delete 1\n.delete /nowhere-at-all\n.exit\n');

    assert.exitCode(result, 0);
    assert.includes(result, 'No breakpoint 1', 'a number is still the debugger’s');
    assert.regex(result, /DELETE http:\/\/localhost:\d+\/nowhere-at-all/, 'a path is a request');
    assert.includes(result, '404', 'which the page’s own server answered');
  });
});
