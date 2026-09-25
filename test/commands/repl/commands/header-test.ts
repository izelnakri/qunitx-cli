import { module, test } from 'qunitx';
import {
  command as header,
  plural as headers,
} from '../../../../lib/commands/repl/commands/header.ts';
import { replContext, saidAll } from '../../../helpers/repl-context.ts';
import '../../../helpers/custom-asserts.ts';

import { store } from '../../../../lib/repl/http-service.ts';
import type { HttpRequest } from '../../../../lib/repl/http-service.ts';

// `.header` is three questions in one command — what am I sending, what did I send, what came
// back — and every one of them is answerable without a socket, because the store is the answer.

module('Commands | repl | .header saving and listing', { concurrency: true }, () => {
  test('bare, it says what it can do rather than answering one of the questions', (assert) => {
    const it = replContext();
    header.main(it.repl, '');
    const said = saidAll(it.printed);

    assert.includes(said, '.header list', 'every shape is on the screen');
    assert.includes(said, '.header delete accept');
    assert.includes(said, '#3', 'including the ones that name an earlier request');
  });

  test('the plural, bare, is the list — the singular is the question about the command', (assert) => {
    const it = replContext();
    headers.main(it.repl, '');
    const plural = saidAll(it.printed);
    it.printed.length = 0;
    header.main(it.repl, '');

    assert.includes(plural, 'accept: application/json', '`.headers` shows them');
    assert.notIncludes(plural, '.header clear', 'and does not explain itself');
    assert.includes(saidAll(it.printed), '.header clear', 'which is what `.header` is for');
  });

  test('everything after the name is one command, whichever name was typed', (assert) => {
    const it = replContext();
    headers.main(it.repl, 'x-token=abc');
    headers.main(it.repl, 'del x-token');

    assert.false(it.http.headers.has('x-token'), 'the plural saves and deletes like the singular');
  });

  test('a session starts with the two headers a browser would send', (assert) => {
    const it = replContext();
    header.main(it.repl, 'list');

    assert.strictEqual(it.http.headers.get('accept'), 'application/json', 'what an API answers in');
    assert.includes(saidAll(it.printed), 'Chrome/', 'and a user-agent a server will recognise');
  });

  test('nothing saved says so, and says how to save one', (assert) => {
    const it = replContext();
    header.main(it.repl, 'clear');
    it.printed.length = 0;
    header.main(it.repl, 'list');

    assert.includes(saidAll(it.printed), 'No headers saved');
    assert.includes(saidAll(it.printed), '.header accept=application/json');
  });

  test('either spelling saves it, and the saving is echoed back', (assert) => {
    const it = replContext();
    header.main(it.repl, 'accept=application/json');
    header.main(it.repl, 'X-Token: abc');

    assert.strictEqual(it.http.headers.get('accept'), 'application/json');
    assert.strictEqual(it.http.headers.get('x-token'), 'abc', 'lower-cased, as HTTP has it');
    // Echoed rather than silent: a header you believe you set and did not is a debugging session
    // about the wrong thing.
    assert.includes(saidAll(it.printed), 'accept: application/json');
    assert.includes(saidAll(it.printed), 'x-token: abc');
  });

  test('`add` is the same thing for hands that want to say the verb', (assert) => {
    const it = replContext();
    header.main(it.repl, 'add accept=text/html');

    assert.strictEqual(it.http.headers.get('accept'), 'text/html');
  });

  test('`add` with nothing to add is told what the shape is', (assert) => {
    const it = replContext();
    header.main(it.repl, 'add');

    assert.includes(saidAll(it.printed), 'Usage: .header add');
  });

  test('listing shows every saved header, sorted', (assert) => {
    const it = replContext();
    it.http.headers.clear();
    it.http.headers.set('x-token', 'abc');
    it.http.headers.set('accept', 'text/html');
    header.main(it.repl, 'list');

    assert.strictEqual(saidAll(it.printed), 'accept: text/html\nx-token: abc');
  });

  test('a bare name asks what that one is set to', (assert) => {
    const it = replContext();
    it.http.headers.set('accept', 'text/html');
    header.main(it.repl, 'accept');

    assert.includes(saidAll(it.printed), 'accept: text/html');
  });

  test('a name that is not set says so rather than printing nothing', (assert) => {
    const it = replContext();
    header.main(it.repl, 'x-token');

    assert.includes(saidAll(it.printed), 'x-token is not set');
  });

  test('something that is not a header name at all is refused by name', (assert) => {
    const it = replContext();
    header.main(it.repl, 'not a header');

    assert.includes(saidAll(it.printed), 'is not a header name');
  });

  test('a header called `list` can still be set, because an assignment is unmistakable', (assert) => {
    const it = replContext();
    header.main(it.repl, 'list=1');

    assert.strictEqual(it.http.headers.get('list'), '1', 'the subcommand did not swallow it');
  });
});

module('Commands | repl | .header removing', { concurrency: true }, () => {
  test('deleting says what it stopped sending', (assert) => {
    const it = replContext();
    it.http.headers.clear();
    it.http.headers.set('accept', 'text/html');
    header.main(it.repl, 'delete accept');

    assert.strictEqual(it.http.headers.size, 0);
    assert.includes(saidAll(it.printed), 'no longer sending accept');
  });

  test('several at once, and it separates the ones that were not there', (assert) => {
    const it = replContext();
    it.http.headers.set('accept', 'text/html');
    header.main(it.repl, 'delete accept x-token');

    assert.includes(saidAll(it.printed), 'no longer sending accept');
    assert.includes(saidAll(it.printed), 'was not sending x-token');
  });

  test('deleting nothing in particular is told what the shape is', (assert) => {
    const it = replContext();
    header.main(it.repl, 'delete');

    assert.includes(saidAll(it.printed), 'Usage: .header delete');
    assert.includes(saidAll(it.printed), '.header clear', 'and the one that means all of them');
  });

  test('clearing says how many went, so an empty session reads as one', (assert) => {
    const it = replContext();
    it.http.headers.clear();
    it.http.headers.set('accept', 'text/html');
    it.http.headers.set('x-token', 'abc');
    header.main(it.repl, 'clear');

    assert.strictEqual(it.http.headers.size, 0);
    assert.includes(saidAll(it.printed), 'cleared 2');
  });

  test('clearing nothing says that too', (assert) => {
    const it = replContext();
    it.http.headers.clear();
    header.main(it.repl, 'clear');

    assert.includes(saidAll(it.printed), 'nothing was saved');
  });
});

module('Commands | repl | .header sent and received', { concurrency: true }, () => {
  test('with no requests yet, both say so and name the command that makes one', (assert) => {
    const it = replContext();
    header.main(it.repl, 'sent');
    header.main(it.repl, 'received');

    assert.strictEqual(it.printed.length, 2);
    assert.includes(saidAll(it.printed), 'No requests yet');
    assert.includes(saidAll(it.printed), '.get /');
  });

  test('`sent` is what went out, and it does not claim to be the whole list', (assert) => {
    const it = replContext();
    it.http.requests.push(buildRequest({ request: new Map([['accept', '*/*']]) }));
    header.main(it.repl, 'sent');
    const said = saidAll(it.printed);

    assert.includes(said, 'accept: */*');
    // The runtime adds several of its own on the way to the socket. Naming them beats either
    // pretending they were not sent or inventing their values.
    assert.includes(said, 'the runtime adds');
  });

  test('`received` is what came back', (assert) => {
    const it = replContext();
    it.http.requests.push(buildRequest({ response: new Map([['x-total', '2']]) }));
    header.main(it.repl, 'received');

    assert.includes(saidAll(it.printed), 'x-total: 2');
  });

  test('`received` on a request that never got a reply says why', (assert) => {
    const it = replContext();
    it.http.requests.push(buildRequest({ failed: 'connection refused' }));
    header.main(it.repl, 'received');

    assert.includes(saidAll(it.printed), 'connection refused');
  });

  test('both are about the LAST request, not the first', (assert) => {
    const it = replContext();
    it.http.requests.push(buildRequest({ response: new Map([['x-which', 'first']]) }));
    it.http.requests.push(buildRequest({ response: new Map([['x-which', 'second']]) }));
    header.main(it.repl, 'received');

    assert.includes(saidAll(it.printed), 'second');
    assert.notIncludes(saidAll(it.printed), 'first');
  });
});

// The same four spellings everybody's muscle memory has, and the two ways of saying WHICH request
// that `.request` takes — a header block should not need a different command to be asked about.
module('Commands | repl | .header by request', { concurrency: true }, () => {
  test('`del` and `rm` delete, like `delete` and `remove`', (assert) => {
    const it = replContext();
    it.http.headers.set('x-one', '1');
    it.http.headers.set('x-two', '2');
    header.main(it.repl, 'del x-one');
    header.main(it.repl, 'rm x-two');

    assert.false(it.http.headers.has('x-one'));
    assert.false(it.http.headers.has('x-two'));
  });

  test('a number is a position and `#n` is an id, resolved the way `.request` resolves them', (assert) => {
    const it = replContext();
    store(it.http, buildRequest({ request: new Map([['x-first', 'yes']]) }));
    store(it.http, buildRequest({ request: new Map([['x-second', 'yes']]) }));

    header.main(it.repl, '2 sent');
    header.main(it.repl, '#1 sent');
    header.main(it.repl, '1 sent');

    assert.includes(it.printed[0] ?? '', 'x-first', 'two back is the first of two');
    assert.includes(it.printed[2] ?? '', 'x-first', '#1 is the first, by name');
    assert.includes(it.printed[4] ?? '', 'x-second', 'and one back is the newest');
  });

  test('which half and which request, in either order', (assert) => {
    const it = replContext();
    store(it.http, buildRequest({ request: new Map([['x-first', 'yes']]) }));
    store(it.http, buildRequest({ request: new Map([['x-second', 'yes']]) }));

    header.main(it.repl, 'sent #1');
    header.main(it.repl, 'sent 2');
    header.main(it.repl, '#1 sent');

    assert.includes(it.printed[0] ?? '', 'x-first', '`sent #1` names the request after the half');
    assert.includes(it.printed[2] ?? '', 'x-first', 'and a position reads the same way round');
    assert.includes(it.printed[4] ?? '', 'x-first', 'which is what `#1 sent` has always said');
  });

  test('a request named after the half still has to exist', (assert) => {
    const it = replContext();
    store(it.http, buildRequest({ request: new Map([['x-sent', 'yes']]) }));
    header.main(it.repl, 'received #4');

    assert.includes(saidAll(it.printed), 'No request #4', 'not the last request, dressed as #4');
    assert.notIncludes(saidAll(it.printed), 'x-sent');
  });

  test('received is a word after the request, not a different command', (assert) => {
    const it = replContext();
    store(it.http, buildRequest({ response: new Map([['x-came-back', 'yes']]) }));
    header.main(it.repl, '#1 received');

    assert.includes(saidAll(it.printed), 'x-came-back');
  });

  test('a request that is not there says so as the thing that was asked for', (assert) => {
    const it = replContext();
    store(it.http, buildRequest({ request: new Map([['x-sent', 'yes']]) }));
    header.main(it.repl, '#9 sent');

    assert.includes(saidAll(it.printed), 'No request #9');
  });
});

/** A request with only the parts these tests read, so each one states what it is about. */
function buildRequest(
  parts: {
    request?: Map<string, string>;
    response?: Map<string, string>;
    failed?: string;
  } = {},
): HttpRequest {
  const failed = parts.failed ?? null;

  return {
    id: 0,
    request: { verb: 'GET', url: 'http://x/y', headers: parts.request ?? new Map(), body: null },
    response:
      failed !== null
        ? null
        : {
            status: 200,
            statusText: 'OK',
            headers: parts.response ?? new Map(),
            body: '{}',
            bytes: 2,
            bodyTruncated: false,
            binary: false,
          },
    failed,
    ms: 3,
    at: Date.now(),
  };
}
