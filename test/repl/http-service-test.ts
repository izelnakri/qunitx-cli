import { module, test } from 'qunitx';
import {
  REQUESTS_KEPT,
  peekRequest,
  formatBytes,
  isValidHeaderName,
  isTextual,
  DEFAULT_HEADERS,
  create,
  parseHeader,
  parseRequestInputTarget,
  store,
  resolveUserInputURL,
  setQueryParams,
  request,
} from '../../lib/repl/http-service.ts';
import { apiServer } from '../helpers/api-server.ts';
import '../helpers/custom-asserts.ts';

import type { HttpRequest } from '../../lib/repl/http-service.ts';

const PAGE = 'http://localhost:4321/index.html';

module('Repl | http | reading what was typed', { concurrency: true }, () => {
  test('a header is written with either separator, and the first one wins', (assert) => {
    assert.deepEqual(parseHeader('Accept=application/json'), {
      name: 'accept',
      value: 'application/json',
    });
    assert.deepEqual(parseHeader('accept: application/json'), {
      name: 'accept',
      value: 'application/json',
    });
    // The `charset=` is part of the VALUE, which only holds if the `:` is what splits it.
    assert.strictEqual(
      parseHeader('content-type: text/html; charset=utf-8')?.value,
      'text/html; charset=utf-8',
    );
    // And the other way round: an `=` before a `:` splits on the `=`.
    assert.strictEqual(parseHeader('x-token=a:b')?.value, 'a:b');
  });

  test('a name is lower-cased, because HTTP does not tell the two apart', (assert) => {
    assert.strictEqual(parseHeader('X-Request-ID=7')?.name, 'x-request-id');
  });

  test('what is not a header at all', (assert) => {
    assert.strictEqual(parseHeader('accept'), null, 'nothing assigned');
    assert.strictEqual(parseHeader(''), null);
    assert.strictEqual(parseHeader('=value'), null, 'no name');
    assert.strictEqual(parseHeader(': value'), null);
    assert.strictEqual(parseHeader('bad header=x'), null, 'a space is not a token character');
  });

  test('an empty value is a value — a header can be sent blank', (assert) => {
    assert.deepEqual(parseHeader('x-quiet='), { name: 'x-quiet', value: '' });
  });

  test('header names are the token characters and nothing else', (assert) => {
    assert.true(isValidHeaderName('x-request-id'));
    assert.true(isValidHeaderName("weird'but*legal"));
    assert.false(isValidHeaderName('x request id'));
    assert.false(isValidHeaderName('x:id'));
    assert.false(isValidHeaderName(''));
  });

  test('a verb prefix is read, and only the five that are verbs', (assert) => {
    assert.deepEqual(parseRequestInputTarget('post:/api/users'), {
      verb: 'POST',
      url: '/api/users',
    });
    assert.deepEqual(parseRequestInputTarget('DELETE:/x'), { verb: 'DELETE', url: '/x' });
    assert.deepEqual(parseRequestInputTarget('/api/users'), { verb: null, url: '/api/users' });
    // The two that would break it if anything with a colon counted.
    assert.deepEqual(parseRequestInputTarget('https://x/y'), { verb: null, url: 'https://x/y' });
    assert.deepEqual(parseRequestInputTarget('localhost:3000/x'), {
      verb: null,
      url: 'localhost:3000/x',
    });
  });
});

module('Repl | http | what a URL means', { concurrency: true }, () => {
  test('a path is the page’s own server, which is the whole point', (assert) => {
    assert.strictEqual(resolveUserInputURL('/tests.js', PAGE), 'http://localhost:4321/tests.js');
    assert.strictEqual(resolveUserInputURL('api/users', PAGE), 'http://localhost:4321/api/users');
    assert.strictEqual(resolveUserInputURL('/a?b=1#c', PAGE), 'http://localhost:4321/a?b=1#c');
  });

  test('a scheme is obeyed exactly', (assert) => {
    assert.strictEqual(resolveUserInputURL('https://example.com/x', PAGE), 'https://example.com/x');
    assert.strictEqual(resolveUserInputURL('http://example.com', PAGE), 'http://example.com/');
  });

  test('the addresses nobody would accept being read as a path', (assert) => {
    assert.strictEqual(resolveUserInputURL('localhost:3000/x', PAGE), 'http://localhost:3000/x');
    assert.strictEqual(resolveUserInputURL('127.0.0.1:8080/x', PAGE), 'http://127.0.0.1:8080/x');
    assert.strictEqual(resolveUserInputURL('//example.com/x', PAGE), 'http://example.com/x');
    assert.strictEqual(resolveUserInputURL('api.test:9000/v1', PAGE), 'http://api.test:9000/v1');
  });

  test('an object is a query, folded into whatever the URL already had', (assert) => {
    assert.strictEqual(
      setQueryParams('http://x/api/users', { page: 2 }),
      'http://x/api/users?page=2',
    );
    assert.strictEqual(
      setQueryParams('http://x/a?page=1&keep=yes', { page: 2 }),
      'http://x/a?page=2&keep=yes',
      'a name already there is replaced — the object is the later statement',
    );
    assert.strictEqual(
      setQueryParams('http://x/a', { tag: ['new', 'old'] }),
      'http://x/a?tag=new&tag=old',
      'a list repeats the name, which is what a server taking one expects',
    );
    assert.strictEqual(
      setQueryParams('http://x/a', { filter: { id: 1 } }),
      'http://x/a?filter=%7B%22id%22%3A1%7D',
      'and anything deeper is JSON',
    );
    assert.strictEqual(
      setQueryParams('http://x/a', { missing: undefined, empty: null, real: 1 }),
      'http://x/a?real=1',
      'a value you do not have is not a parameter',
    );
    assert.strictEqual(
      setQueryParams('http://x/a', { 'q w': 'a&b' }),
      'http://x/a?q+w=a%26b',
      'encoding is the URL’s own, not ours',
    );
  });

  test('a bare port is this machine, which is where the other terminal is', (assert) => {
    assert.strictEqual(
      resolveUserInputURL(':4000/api/users', PAGE),
      'http://localhost:4000/api/users',
    );
    assert.strictEqual(resolveUserInputURL(':4000', PAGE), 'http://localhost:4000/');
    assert.strictEqual(resolveUserInputURL(':4000/a?b=1', PAGE), 'http://localhost:4000/a?b=1');
    // A colon that is not a port is not an address: nothing is guessed, so it stays a path.
    assert.strictEqual(resolveUserInputURL(':name/x', PAGE), 'http://localhost:4321/:name/x');
  });

  test('a bare domain is a path, deliberately — `tests.js` is the commoner thing to type', (assert) => {
    // The trade is stated where the rule is: no heuristic separates `bbc.co.uk` from `tests.js`
    // without a list of every TLD, and one of the two is typed at this prompt constantly.
    assert.strictEqual(resolveUserInputURL('tests.js', PAGE), 'http://localhost:4321/tests.js');
    assert.strictEqual(
      resolveUserInputURL('example.com/x', PAGE),
      'http://localhost:4321/example.com/x',
    );
  });

  test('nothing usable is null rather than a throw', (assert) => {
    assert.strictEqual(resolveUserInputURL('', PAGE), null);
    assert.strictEqual(resolveUserInputURL('   ', PAGE), null);
    assert.strictEqual(resolveUserInputURL('/tests.js', null), null, 'nothing to be relative to');
  });
});

module('Repl | http | the session’s record', { concurrency: true }, () => {
  test('a new store has no requests, and the two headers a browser would send', (assert) => {
    const httpService = create();

    assert.strictEqual(httpService.requests.length, 0);
    // Saved rather than applied at send time, so `.header list` shows them and `.header delete`
    // can drop them: nothing is sent that a session cannot see.
    assert.strictEqual(httpService.headers.get('accept'), 'application/json');
    assert.true(httpService.headers.get('user-agent')?.includes('Chrome/') ?? false);
  });

  test('the log is capped, and it is the oldest that go', (assert) => {
    const httpService = create();
    for (let at = 0; at < REQUESTS_KEPT + 10; at++) {
      store(httpService, made('GET', `http://x/${at}`));
    }

    assert.strictEqual(httpService.requests.length, REQUESTS_KEPT);
    assert.strictEqual(
      httpService.requests[0]?.request.url,
      'http://x/10',
      'the first ten are gone',
    );
    assert.strictEqual(httpService.requests.at(-1)?.request.url, `http://x/${REQUESTS_KEPT + 9}`);
  });

  test('a bare lookup is the last request of all', (assert) => {
    const httpService = create();
    store(httpService, made('GET', 'http://x/one'));
    store(httpService, made('POST', 'http://x/two'));

    assert.strictEqual(peekRequest(httpService, null, '')?.request.url, 'http://x/two');
  });

  test('the newest match wins, and a verb narrows it', (assert) => {
    const httpService = create();
    store(httpService, made('GET', 'http://x/api/users'));
    store(httpService, made('POST', 'http://x/api/users'));
    store(httpService, made('GET', 'http://x/api/other'));

    assert.strictEqual(
      peekRequest(httpService, null, '/api/users')?.request.verb,
      'POST',
      'the later one',
    );
    assert.strictEqual(peekRequest(httpService, 'GET', '/api/users')?.request.verb, 'GET');
  });

  test('matching is forgiving, so a query string need not be pasted back', (assert) => {
    const httpService = create();
    store(httpService, made('GET', 'http://localhost:4321/api/users?page=2'));

    assert.ok(peekRequest(httpService, null, 'users'), 'any part of it finds it');
    assert.ok(peekRequest(httpService, null, '/api/users'), 'and so does the path');
    assert.strictEqual(peekRequest(httpService, null, '/api/nowhere'), null);
  });

  test('an exact resolved URL matches even where the text would not', (assert) => {
    const httpService = create();
    store(httpService, made('GET', 'http://localhost:4321/tests.js'));

    // `/tests.js` does not appear in the URL as a substring of a path-relative typing, so this
    // only passes because the target is resolved against the page before it is compared.
    assert.ok(peekRequest(httpService, null, 'tests.js', PAGE));
  });

  test('nothing sent is null, not an exception', (assert) => {
    assert.strictEqual(peekRequest(create(), null, '/x'), null);
  });
});

module('Repl | http | saying sizes and types', { concurrency: true }, () => {
  test('bytes read the way a person reads them', (assert) => {
    assert.strictEqual(formatBytes(0), '0 bytes');
    assert.strictEqual(formatBytes(1), '1 byte', 'singular, because it reads wrong otherwise');
    assert.strictEqual(formatBytes(812), '812 bytes');
    assert.strictEqual(formatBytes(4_300), '4.2 KB');
    assert.strictEqual(formatBytes(3_000_000), '2.9 MB');
  });

  test('what a terminal can be asked to print', (assert) => {
    assert.true(isTextual('text/html; charset=utf-8'));
    assert.true(isTextual('application/json'));
    assert.true(isTextual('application/vnd.api+json'), 'every API invents one of these');
    assert.true(isTextual('image/svg+xml'), 'an image that is text');
    assert.true(isTextual(''), 'nothing said, so assume it can be read');
    assert.false(isTextual('image/png'));
    assert.false(isTextual('application/octet-stream'));
  });
});

module('Repl | http | buildCommand one', { concurrency: true }, () => {
  test('a request comes back with its status, headers and body', async (assert) => {
    await using api = await apiServer();
    const connection = await request({
      verb: 'GET',
      url: `${api.url}/api/users`,
      headers: new Map(),
    });

    assert.strictEqual(connection.failed, null);
    assert.strictEqual(connection.response?.status, 200);
    assert.strictEqual(
      connection.response?.headers.get('x-total'),
      '2',
      'header names lower-cased',
    );
    assert.includes(connection.response?.body ?? '', 'Ada');
    assert.true(connection.ms >= 0, 'and how long it took');
  });

  test('the defaults every client sets, and none of them overriding what was asked', async (assert) => {
    await using api = await apiServer();
    const asked = new Map([['accept', 'application/json']]);
    const connection = await request({
      verb: 'GET',
      url: `${api.url}/echo-headers`,
      headers: asked,
    });
    const seen = JSON.parse(connection.response?.body ?? '{}') as Record<string, string>;

    assert.strictEqual(seen['accept'], 'application/json', 'what was saved is what was sent');
    // The same default the store seeds, rather than a second one only `send` knew about: a
    // request that bypasses a session should not claim to be something else.
    assert.strictEqual(seen['user-agent'], DEFAULT_HEADERS.get('user-agent'));
    assert.strictEqual(
      connection.request.headers.get('accept'),
      'application/json',
      'and recorded',
    );
  });

  test('a body starting `{` is JSON, unless the session already said otherwise', async (assert) => {
    await using api = await apiServer();
    const guessed = await request({
      verb: 'POST',
      url: `${api.url}/echo-headers`,
      headers: new Map(),
      body: '{"name":"Ada"}',
    });
    const told = await request({
      verb: 'POST',
      url: `${api.url}/echo-headers`,
      headers: new Map([['content-type', 'text/plain']]),
      body: '{"name":"Ada"}',
    });

    assert.strictEqual(guessed.request.headers.get('content-type'), 'application/json');
    assert.strictEqual(told.request.headers.get('content-type'), 'text/plain', 'not overridden');
  });

  test('a body that is not text is counted and not decoded', async (assert) => {
    await using api = await apiServer();
    const connection = await request({ verb: 'GET', url: `${api.url}/image`, headers: new Map() });

    assert.true(connection.response?.binary, 'a PNG is not something to print');
    assert.strictEqual(connection.response?.body, '', 'so it is not even decoded');
    assert.strictEqual(connection.response?.bytes, 3_000, 'but it is still counted honestly');
  });

  test('an endless body is cut at the cap rather than after it', async (assert) => {
    await using api = await apiServer();
    const connection = await request({
      verb: 'GET',
      url: `${api.url}/big`,
      headers: new Map(),
      maxBytes: 1_000,
    });

    assert.true(connection.response?.bodyTruncated, 'and it says so');
    assert.strictEqual(connection.response?.body.length, 1_000, 'exactly the cap, not the chunk');
  });

  test('a refused connection is an answer, not a thrown error', async (assert) => {
    const connection = await request({
      verb: 'GET',
      url: 'http://127.0.0.1:1/nothing',
      headers: new Map(),
    });

    assert.strictEqual(connection.response, null);
    assert.true((connection.failed?.length ?? 0) > 0, 'and it says what happened');
    assert.notIncludes(connection.failed ?? '', '()', 'without an empty parenthetical');
  });

  test('a server that never answers is abandoned, and says how long it waited', async (assert) => {
    await using api = await apiServer();
    const connection = await request({
      verb: 'GET',
      url: `${api.url}/forever`,
      headers: new Map(),
      timeoutMs: 150,
    });

    assert.strictEqual(connection.response, null);
    assert.includes(connection.failed ?? '', 'no answer within');
  });

  test('a 404 is a reply, not a failure — it is often the one you went looking for', async (assert) => {
    await using api = await apiServer();
    const connection = await request({
      verb: 'GET',
      url: `${api.url}/nowhere`,
      headers: new Map(),
    });

    assert.strictEqual(connection.failed, null, 'nothing went wrong with the request');
    assert.strictEqual(connection.response?.status, 404);
  });
});

/** An connection with nothing in it but the two fields a lookup reads. */
function made(verb: string, url: string): HttpRequest {
  return {
    request: { verb, url, headers: new Map(), body: null },
    response: null,
    failed: 'not sent, this is a fixture',
    ms: 0,
    at: Date.now(),
  };
}
