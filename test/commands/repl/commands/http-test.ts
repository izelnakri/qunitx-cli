import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';
import { module, test } from 'qunitx';
import { buildCommand } from '../../../../lib/commands/repl/commands/http.ts';
import { apiServer } from '../../../helpers/api-server.ts';
import { replContext, saidAll } from '../../../helpers/repl-context.ts';
import { tempDir } from '../../../helpers/temp-dir.ts';
import '../../../helpers/custom-asserts.ts';

const get = buildCommand('GET');
const post = buildCommand('POST');

// The five verb commands, driven the way `define` drives them: a context and an argument, no
// terminal and no browser. What a page would give them is one string — the URL a path is relative
// to — and the helper supplies it.

module('Commands | repl | .get and its siblings', { concurrency: true }, () => {
  test('a URL is requested, and what came back is printed', async (assert) => {
    await using api = await apiServer();
    const it = replContext();
    await get.main(it.repl, `${api.url}/api/users`);
    const said = saidAll(it.printed);

    assert.includes(said, `GET ${api.url}/api/users`, 'what was asked for');
    assert.includes(said, '200 OK', 'and what came back');
    assert.includes(said, '"name": "Ada"', 're-indented, because an API answers a machine');
  });

  test('a path is the page’s own server — the reason this lives in a browser REPL', async (assert) => {
    await using api = await apiServer();
    const it = replContext({ page: `${api.url}/index.html` });
    await get.main(it.repl, '/api/users');

    assert.includes(saidAll(it.printed), `GET ${api.url}/api/users`);
    assert.includes(saidAll(it.printed), '200 OK');
  });

  test('every request is kept, so `.request` can be asked about it later', async (assert) => {
    await using api = await apiServer();
    const it = replContext();
    await get.main(it.repl, `${api.url}/api/users`);

    assert.strictEqual(it.http.requests.length, 1);
    assert.strictEqual(it.http.requests[0]?.response?.status, 200);
  });

  test('saved headers are sent, which is the whole point of saving them', async (assert) => {
    await using api = await apiServer();
    const it = replContext();
    it.http.headers.set('x-token', 'abc');
    await get.main(it.repl, `${api.url}/echo-headers`);
    const seen = JSON.parse(it.http.requests[0]?.response?.body ?? '{}') as Record<string, string>;

    assert.strictEqual(seen['x-token'], 'abc', 'the server saw it');
  });

  test('nothing after the command is the shape of its argument, not an error', (assert) => {
    const it = replContext();
    get.main(it.repl, '');

    assert.includes(saidAll(it.printed), 'Usage: .get <url>');
    assert.includes(saidAll(it.printed), 'the page’s own server', 'and the rule for paths');
  });

  test('a target that cannot be a URL says so instead of failing somewhere else', (assert) => {
    // No page: there is nothing for a path to be relative to, which is the pipe-with-no-session
    // case rather than a typo.
    const it = replContext({ page: null });
    get.main(it.repl, '/api/users');

    assert.includes(saidAll(it.printed), 'cannot make a URL');
  });

  test('an object after a GET’s URL is its query, not a body it cannot carry', async (assert) => {
    await using api = await apiServer();
    const it = replContext({ evaluate: (expression) => vm.runInNewContext(`(${expression})`, {}) });
    await get.main(it.repl, `${api.url}/api/users { page: 2, tag: 'new' }`);

    assert.strictEqual(
      it.http.requests[0]?.request.url,
      `${api.url}/api/users?page=2&tag=new`,
      'written as an object, sent as a query',
    );
    assert.strictEqual(it.http.requests[0]?.request.body, null, 'and still no body');
  });

  test('a GET given something that cannot be a query says which commands take one', async (assert) => {
    const it = replContext();
    await get.main(it.repl, 'http://127.0.0.1:1/x hello');

    assert.includes(saidAll(it.printed), 'sends no body');
    assert.includes(saidAll(it.printed), 'is its query', 'naming what an object would have done');
    assert.includes(saidAll(it.printed), '.post', 'and the command that takes a body');
    assert.strictEqual(it.http.requests.length, 0, 'and nothing was sent');
  });

  test('a POST carries what follows the URL', async (assert) => {
    await using api = await apiServer();
    const it = replContext();
    await post.main(it.repl, `${api.url}/api/users {"name":"Ada"}`);

    assert.includes(saidAll(it.printed), '201 Created');
    assert.includes(saidAll(it.printed), 'Ada', 'the server echoed back what it was sent');
    assert.strictEqual(it.http.requests[0]?.request.body, '{"name":"Ada"}', 'and it was recorded');
  });

  test('a body long enough to matter comes from a file, the way `curl -d @` takes one', async (assert) => {
    await using api = await apiServer();
    await using directory = await tempDir('repl-http-body');
    await fs.writeFile(path.join(directory.path, 'body.json'), '{"name":"Grace"}');
    const it = replContext({ cwd: directory.path });
    await post.main(it.repl, `${api.url}/api/users @body.json`);

    assert.strictEqual(it.http.requests[0]?.request.body, '{"name":"Grace"}');
    assert.includes(saidAll(it.printed), '201 Created');
  });

  test('`:` needs an editor, and says so rather than failing somewhere else', async (assert) => {
    await using api = await apiServer();
    const it = replContext();
    const [visual, editor] = [process.env.VISUAL, process.env.EDITOR];
    delete process.env.VISUAL;
    delete process.env.EDITOR;
    try {
      await post.main(it.repl, `${api.url}/api/users :`);
    } finally {
      if (visual !== undefined) process.env.VISUAL = visual;
      if (editor !== undefined) process.env.EDITOR = editor;
    }

    assert.includes(saidAll(it.printed), 'no $EDITOR set');
    assert.strictEqual(it.http.requests.length, 0, 'and nothing was sent');
  });

  test('a file that is not there is a sentence, not a crash', async (assert) => {
    await using api = await apiServer();
    const it = replContext();
    await post.main(it.repl, `${api.url}/api/users @nowhere.json`);

    assert.includes(saidAll(it.printed), 'no file at nowhere.json');
    assert.strictEqual(it.http.requests.length, 0, 'and nothing was sent');
  });

  test('a body that is not text is described rather than printed at a terminal', async (assert) => {
    await using api = await apiServer();
    const it = replContext();
    await get.main(it.repl, `${api.url}/image`);
    const said = saidAll(it.printed);

    assert.includes(said, 'image/png');
    assert.includes(said, 'not shown');
  });

  test('a refused connection is printed, and the session carries on', async (assert) => {
    const it = replContext();
    await get.main(it.repl, 'http://127.0.0.1:1/nothing');

    // One line, not two: what happened and what it happened to, the same shape a reply gets.
    assert.strictEqual(it.printed.length, 1, 'the failure and the target, together');
    assert.includes(
      saidAll(it.printed),
      '| GET http://127.0.0.1:1/nothing',
      'a failure still says which request it was',
    );
    assert.strictEqual(it.http.requests.length, 1, 'a failure is still a request that was made');
    assert.strictEqual(it.http.requests[0]?.response, null);
  });

  test('each verb says its own name, in help and on the wire', async (assert) => {
    await using api = await apiServer();
    const it = replContext();
    await buildCommand('PATCH').main(it.repl, `${api.url}/api/users/1 {"name":"Ada Lovelace"}`);

    assert.strictEqual(it.http.requests[0]?.request.verb, 'PATCH');
    assert.includes(saidAll(it.printed), 'Ada Lovelace', 'and the API merged what it was sent');
    assert.includes(saidAll(it.printed), 'ada@example.com', 'leaving the rest of the user alone');
    assert.includes(buildCommand('PUT').description, '.put');
  });
});

// The prompt is a JavaScript one, so a body typed at it is JavaScript. `vm` stands in for the page
// here — another realm evaluating the expression and handing back the value, which is what the
// session does over CDP.
module('Commands | repl | a body is JavaScript', { concurrency: true }, () => {
  const page =
    (scope: Record<string, unknown> = {}) =>
    (expression: string): unknown =>
      vm.runInNewContext(`(${expression})`, { ...scope });

  test('an object literal is a body, unquoted keys and all', async (assert) => {
    await using api = await apiServer();
    const it = replContext({ evaluate: page() });
    await post.main(it.repl, `${api.url}/api/users { name: "Izel" }`);

    assert.strictEqual(
      it.http.requests[0]?.request.body,
      '{"name":"Izel"}',
      'quoted on the way out',
    );
    assert.includes(saidAll(it.printed), '201 Created', 'which is what the API wanted all along');
  });

  test('a class instance is the object it is, `toJSON` included', async (assert) => {
    await using api = await apiServer();
    const scope = {
      user: new (class User {
        name = 'Izel';
        secret = 'unsent';
        toJSON() {
          return { name: this.name };
        }
      })(),
    };
    const it = replContext({ evaluate: page(scope) });
    await post.main(it.repl, `${api.url}/api/users user`);

    assert.strictEqual(it.http.requests[0]?.request.body, '{"name":"Izel"}');
    assert.notIncludes(
      it.http.requests[0]?.request.body ?? '',
      'unsent',
      'toJSON decided, in the page',
    );
  });

  test('a body in backticks is still JavaScript, not five characters of punctuation', async (assert) => {
    await using api = await apiServer();
    const it = replContext({ evaluate: page() });
    await post.main(it.repl, `${api.url}/api/users \`{ name: "Izel" }\``);

    assert.strictEqual(it.http.requests[0]?.request.body, '{"name":"Izel"}');
  });

  test('a string is a text body, which is what a string is for', async (assert) => {
    await using api = await apiServer();
    const it = replContext({ evaluate: page({ who: 'Izel' }) });
    await post.main(it.repl, `${api.url}/echo-headers \`hello \${who}\``);

    assert.strictEqual(it.http.requests[0]?.request.body, 'hello Izel', 'interpolated, then sent');
  });

  test('JSON typed as JSON is unchanged, since it already says what it means', async (assert) => {
    await using api = await apiServer();
    const it = replContext({ evaluate: page() });
    await post.main(it.repl, `${api.url}/api/users {"name":"Ada"}`);

    assert.strictEqual(it.http.requests[0]?.request.body, '{"name":"Ada"}');
  });

  test('what the page cannot make sense of is sent exactly as it was typed', async (assert) => {
    await using api = await apiServer();
    const it = replContext({ evaluate: page() });
    await post.main(it.repl, `${api.url}/echo-headers nothingDeclaredHere`);

    assert.strictEqual(
      it.http.requests[0]?.request.body,
      'nothingDeclaredHere',
      'a prompt never refuses a body for not being code',
    );
  });

  test('a context with no page behind it sends the text, and says nothing about it', async (assert) => {
    await using api = await apiServer();
    const it = replContext();
    await post.main(it.repl, `${api.url}/echo-headers { name: "Izel" }`);

    assert.strictEqual(it.http.requests[0]?.request.body, '{ name: "Izel" }');
  });
});
