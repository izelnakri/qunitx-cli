import { module, test } from 'qunitx';
import {
  command as request,
  getHeaderType,
  getHeaderName,
  parseRequestPart,
} from '../../../../lib/commands/repl/commands/request.ts';
import { replContext, saidAll } from '../../../helpers/repl-context.ts';
import '../../../helpers/custom-asserts.ts';

import { store, parseRequestKind } from '../../../../lib/repl/http-service.ts';
import type { HttpRequest } from '../../../../lib/repl/http-service.ts';

// `.request` is the other half of a verb command: the answer was printed once in the shape that
// suited reading it, and this is how a narrower question gets asked about it afterwards.

module('Commands | repl | .request reading its argument', { concurrency: true }, () => {
  test('a kind is read off the end, so the URL can be anything', (assert) => {
    assert.deepEqual(parseRequestPart('/api/users headers sent'), {
      kind: 'headers-sent',
      target: '/api/users',
    });
    assert.deepEqual(parseRequestPart('/api/users headers received'), {
      kind: 'headers-received',
      target: '/api/users',
    });
    assert.deepEqual(parseRequestPart('/api/users body'), { kind: 'body', target: '/api/users' });
    assert.deepEqual(parseRequestPart('/api/users status'), {
      kind: 'status',
      target: '/api/users',
    });
  });

  test('`headers` on its own means the ones that came back', (assert) => {
    assert.deepEqual(parseRequestPart('/x headers'), { kind: 'headers-received', target: '/x' });
  });

  test('a kind with no URL is the last request', (assert) => {
    assert.deepEqual(parseRequestPart('body'), { kind: 'body', target: '' });
    assert.deepEqual(parseRequestPart(''), { kind: 'whole', target: '' });
  });

  test('a side can be said as a field too — `headers.sent` is `headers sent`', (assert) => {
    assert.strictEqual(getHeaderType('headers.sent'), 'sent');
    assert.strictEqual(getHeaderType('headers.received'), 'received');
    assert.strictEqual(getHeaderType('header.sent'), 'sent', 'singular reads the same');
    assert.strictEqual(getHeaderType('.headers.received'), 'received', 'a leading dot is forgiven');
    assert.strictEqual(getHeaderType("headers['sent']"), 'sent', 'and so are brackets');
    assert.strictEqual(getHeaderType('headers.etag'), null, 'a name is a different question');

    assert.deepEqual(parseRequestPart('/api/users headers.sent'), {
      kind: 'headers-sent',
      target: '/api/users',
    });
    assert.deepEqual(parseRequestPart('/api/users .headers'), {
      kind: 'headers-received',
      target: '/api/users',
    });
    // The two side words are never read as header names, which is what used to answer
    // `no sent received` to a question about the sent headers.
    assert.strictEqual(getHeaderName('headers.sent'), null);
    assert.strictEqual(getHeaderName('headers.received'), null);
  });

  test('one header by name, in either spelling JavaScript hands', (assert) => {
    assert.strictEqual(getHeaderName('headers.etag'), 'etag');
    assert.strictEqual(
      getHeaderName('header.date'),
      'date',
      'singular too — one is what you asked for',
    );
    assert.strictEqual(getHeaderName('header["date"]'), 'date');
    assert.strictEqual(getHeaderName('headers[content-type]'), 'content-type');
    assert.strictEqual(getHeaderName("headers['content-type']"), 'content-type');
    assert.strictEqual(
      getHeaderName('headers["X-Total"]'),
      'x-total',
      'lower-cased, as HTTP has it',
    );
    assert.strictEqual(getHeaderName('headers'), null, 'all of them is a different question');
    assert.strictEqual(getHeaderName('body'), null);

    assert.deepEqual(parseRequestPart('/api/users headers.etag'), {
      kind: 'headers-received',
      target: '/api/users',
      name: 'etag',
    });
    assert.deepEqual(parseRequestPart('/api/users headers[accept] sent'), {
      kind: 'headers-sent',
      target: '/api/users',
      name: 'accept',
    });
  });

  test('a URL that happens to be a kind word still works, read from the end', (assert) => {
    assert.deepEqual(parseRequestPart('/body body'), { kind: 'body', target: '/body' });
    assert.deepEqual(parseRequestPart('/status'), { kind: 'whole', target: '/status' });
  });
});

module('Commands | repl | .request answering', { concurrency: true }, () => {
  test('with nothing sent yet it says so, and names the command that sends one', (assert) => {
    const it = replContext();
    request.main(it.repl, '');

    assert.includes(saidAll(it.printed), 'No requests yet');
    assert.includes(saidAll(it.printed), '.get /');
  });

  test('bare, it is everything about the last request', (assert) => {
    const it = replContext();
    it.http.requests.push(buildRequest('GET', 'http://x/api/users'));
    request.main(it.repl, '');
    const said = saidAll(it.printed);

    assert.includes(said, 'GET http://x/api/users');
    assert.includes(said, '200 OK');
    assert.includes(said, 'x-total: 2', 'the headers that came back');
    assert.includes(said, '"name": "Ada"', 'and the body');
  });

  test('a URL picks one out, forgivingly', (assert) => {
    const it = replContext();
    it.http.requests.push(buildRequest('GET', 'http://x/api/users?page=2'));
    it.http.requests.push(buildRequest('GET', 'http://x/api/other'));
    request.main(it.repl, 'users status');

    assert.includes(saidAll(it.printed), '200 OK');
    assert.notIncludes(saidAll(it.printed), 'other');
  });

  test('a verb prefix narrows it to that verb', (assert) => {
    const it = replContext();
    it.http.requests.push(buildRequest('GET', 'http://x/api/users'));
    it.http.requests.push(buildRequest('POST', 'http://x/api/users'));
    request.main(it.repl, 'get:/api/users');

    assert.includes(saidAll(it.printed), 'GET http://x/api/users');
    assert.notIncludes(saidAll(it.printed), 'POST');
  });

  test('just the status', (assert) => {
    const it = replContext();
    it.http.requests.push(buildRequest('GET', 'http://x/y'));
    request.main(it.repl, 'status');

    assert.strictEqual(it.printed.length, 1, 'one line, which is what was asked for');
    assert.includes(saidAll(it.printed), '200 OK');
  });

  test('just the headers, either side, and `sent` says what it leaves out', (assert) => {
    const it = replContext();
    it.http.requests.push(buildRequest('GET', 'http://x/y'));
    request.main(it.repl, 'headers received');
    request.main(it.repl, 'headers sent');
    const said = saidAll(it.printed);

    assert.includes(said, 'x-total: 2', 'what came back');
    assert.includes(said, 'accept: */*', 'and what went out');
    assert.includes(said, 'the runtime adds');
  });

  test('the body is given WHOLE, however long — a narrow question deserves a full answer', (assert) => {
    const it = replContext();
    const long = Array.from({ length: 200 }, (_, at) => `line ${at}`).join('\n');
    it.http.requests.push(buildRequest('GET', 'http://x/y', { body: long, type: 'text/plain' }));
    request.main(it.repl, 'body');
    const said = saidAll(it.printed);

    assert.includes(said, 'line 199');
    assert.notIncludes(said, 'more lines', 'nothing was held back, so nothing is announced');
  });

  test('a kind of a request that never got a reply says why instead', (assert) => {
    const it = replContext();
    it.http.requests.push({
      ...buildRequest('GET', 'http://x/y'),
      response: null,
      failed: 'refused',
    });
    request.main(it.repl, 'body');

    assert.includes(saidAll(it.printed), 'refused');
  });

  test('a URL nothing matches is said in terms of what was looked for', (assert) => {
    const it = replContext();
    it.http.requests.push(buildRequest('GET', 'http://x/y'));
    request.main(it.repl, '/nowhere');

    assert.includes(saidAll(it.printed), 'No request to /nowhere');
    assert.includes(saidAll(it.printed), '.request list');
  });
});

// A list is read newest-first by the eye, whatever order it is printed in, so `.request 2` counts
// the way the eye counts: back from the one that just happened.
module('Commands | repl | .request one header', { concurrency: true }, () => {
  test('a named header answers with that one, from the side that was named', (assert) => {
    const it = replContext();
    store(it.http, buildRequest('GET', 'http://x/api/users'));

    request.main(it.repl, '/api/users headers.sent');
    it.printed.length = 0;
    request.main(it.repl, '/api/users headers.x-total');
    request.main(it.repl, '/api/users headers[accept] sent');
    request.main(it.repl, '/api/users header.x-total');

    assert.includes(it.printed[0] ?? '', 'x-total: 2');
    assert.includes(it.printed[1] ?? '', 'accept: */*', 'brackets read the sent side too');
    assert.includes(it.printed[2] ?? '', 'x-total: 2', 'and the singular says the same thing');
  });

  test('a header that is not there says which side it looked at', (assert) => {
    const it = replContext();
    store(it.http, buildRequest('GET', 'http://x/api/users'));

    request.main(it.repl, '/api/users headers.etag');

    assert.includes(saidAll(it.printed), 'no etag received');
  });
});

module('Commands | repl | .request counting back', { concurrency: true }, () => {
  test('a bare number is a position, not a URL', (assert) => {
    assert.deepEqual(parseRequestKind('1'), { kind: 'position', back: 1 });
    assert.deepEqual(parseRequestKind(' 3 '), { kind: 'position', back: 3 });
    assert.strictEqual(parseRequestKind('0').kind, 'url', 'there is no zeroth request');
    assert.strictEqual(parseRequestKind('/api/users').kind, 'url');
    assert.strictEqual(parseRequestKind('users/2').kind, 'url', 'a number INSIDE a URL is the URL');
  });

  test('1 is the last request, 2 the one before it', (assert) => {
    const it = replContext();
    store(it.http, buildRequest('GET', 'http://x/first'));
    store(it.http, buildRequest('POST', 'http://x/second'));
    store(it.http, buildRequest('PATCH', 'http://x/third'));

    request.main(it.repl, '1 status');
    request.main(it.repl, '2 status');
    request.main(it.repl, '3 status');

    assert.includes(it.printed[0] ?? '', 'http://x/third');
    assert.includes(it.printed[1] ?? '', 'http://x/second');
    assert.includes(it.printed[2] ?? '', 'http://x/first');
  });

  test('a number past the end says how many there are, not what it could not find', (assert) => {
    const it = replContext();
    store(it.http, buildRequest('GET', 'http://x/one'));
    request.main(it.repl, '9');

    assert.includes(saidAll(it.printed), 'Only 1 request so far');
    assert.notIncludes(saidAll(it.printed), 'No request to 9', 'a position is a different mistake');
  });
});

// A position and an id answer two different questions: "the one before last" moves as you work,
// and "#2" is the name a request keeps.
module('Commands | repl | .request by id', { concurrency: true }, () => {
  test('a `#` is a name, a bare number is a position', (assert) => {
    assert.deepEqual(parseRequestKind('#7'), { kind: 'id', id: 7 });
    assert.deepEqual(parseRequestKind(' #1 '), { kind: 'id', id: 1 });
    assert.strictEqual(parseRequestKind('#0').kind, 'url', 'ids start at one');
    assert.deepEqual(
      parseRequestKind('2'),
      { kind: 'position', back: 2 },
      'a bare number counts back',
    );
    assert.strictEqual(parseRequestKind('/api/users#2').kind, 'url', 'a fragment is part of a URL');
  });

  test('ids are handed out in order and keep meaning the same request', (assert) => {
    const it = replContext();
    [1, 2, 3].forEach((nth) => {
      const connection = buildRequest('GET', `http://x/${nth}`);
      store(it.http, connection);
    });

    request.main(it.repl, '#1 status');
    request.main(it.repl, '#3 status');

    assert.deepEqual(
      it.http.requests.map((connection) => connection.id),
      [1, 2, 3],
      'counted up as they were made',
    );
    assert.includes(
      it.printed[0] ?? '',
      'http://x/1',
      '#1 is still the first, not the oldest kept',
    );
    assert.includes(it.printed[1] ?? '', 'http://x/3');
  });

  test('an id nobody handed out says so as an id', (assert) => {
    const it = replContext();
    store(it.http, buildRequest('GET', 'http://x/one'));
    request.main(it.repl, '#9');

    assert.includes(saidAll(it.printed), 'No request #9');
  });
});

module('Commands | repl | .request list', { concurrency: true }, () => {
  test('every request, one line each, newest first', (assert) => {
    const it = replContext();
    store(it.http, buildRequest('GET', 'http://x/one'));
    store(it.http, buildRequest('POST', 'http://x/two'));
    request.main(it.repl, 'list');
    const lines = saidAll(it.printed).trimEnd().split('\n');

    assert.strictEqual(lines.length, 2);
    // The one you just made is the one you are looking for, and a prompt scrolls away from you.
    // It also puts the list in the order `.request 1`, `.request 2` counts in.
    assert.includes(lines[0] ?? '', 'http://x/two', 'newest at the top');
    assert.includes(lines[1] ?? '', 'http://x/one');
    assert.regex(
      lines[0] ?? '',
      /just now\s+#2\s+200\s+POST\s+http:\/\/x\/two/,
      'age, id, status, verb, where — the same order every line has',
    );
  });

  test('the first line is `.request 1`, so the list and the position agree', (assert) => {
    const it = replContext();
    store(it.http, buildRequest('GET', 'http://x/older'));
    store(it.http, buildRequest('POST', 'http://x/newer'));
    request.main(it.repl, 'list');
    const top = saidAll(it.printed).trimEnd().split('\n')[0] ?? '';
    it.printed.length = 0;
    request.main(it.repl, '1 status');

    assert.includes(top, 'http://x/newer');
    assert.includes(saidAll(it.printed), 'http://x/newer', 'the same request, both ways of asking');
  });

  test('an empty list says so rather than printing a blank line', (assert) => {
    const it = replContext();
    request.main(it.repl, 'list');

    assert.includes(saidAll(it.printed), 'No requests yet');
  });
});

/** An connection that got a reply, with the parts these tests read and quiet defaults elsewhere. */
function buildRequest(
  verb: string,
  url: string,
  reply: { body?: string; type?: string } = {},
): HttpRequest {
  const body = reply.body ?? JSON.stringify([{ id: 1, name: 'Ada' }]);

  return {
    id: 0,
    request: { verb, url, headers: new Map([['accept', '*/*']]), body: null },
    response: {
      status: 200,
      statusText: 'OK',
      headers: new Map([
        ['content-type', reply.type ?? 'application/json'],
        ['x-total', '2'],
      ]),
      body,
      bytes: body.length,
      bodyTruncated: false,
      binary: false,
    },
    failed: null,
    ms: 5,
    at: Date.now(),
  };
}
