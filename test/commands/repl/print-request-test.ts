import { module, test } from 'qunitx';
import {
  agoInWords,
  printBody,
  printRequest,
  printRequestLine,
  printHeaders,
  printStatus,
  printTarget,
  durationTone,
  sizeTone,
  statusTone,
} from '../../../lib/commands/repl/print-request.ts';
import '../../helpers/custom-asserts.ts';

import type { HttpRequest, Response } from '../../../lib/repl/http-service.ts';

const plain = { painter: () => (text: string) => text };

// Data in, string out — the same shape as `drawTree`, so none of this needs a terminal.

module('Commands | repl | drawing a request', { concurrency: true }, () => {
  test('the phrase a request is known by', (assert) => {
    assert.strictEqual(printTarget(buildBasicHttpRequest('GET', 'http://x/y')), 'GET http://x/y');
  });

  test('what came back, in one line — and what it came back from', (assert) => {
    const line = printStatus(
      buildRespondedHttpRequest({ status: 200, statusText: 'OK', bytes: 47 }, 23),
      plain,
    );

    assert.includes(line, '200 OK');
    assert.includes(line, '47 bytes');
    assert.includes(line, '23ms');
    assert.includes(
      line,
      '| GET http://x/y',
      'the target rides along, so nothing needs its own line',
    );
    // And the id last, in the spelling that asks for it again — no label, because a label is a
    // word to translate where `#4` is a word to copy.
    assert.true(line.endsWith('| #4'), `the id ends the line, got: ${line}`);
  });

  test('a status wears its class: 2xx good, 3xx moved, 4xx information, 5xx broken', (assert) => {
    assert.strictEqual(statusTone(200), 'good');
    assert.strictEqual(statusTone(204), 'good');
    assert.strictEqual(statusTone(301), 'warn');
    // Blue rather than yellow, and it is not a detail: a 404 is an answer, and often the one you
    // went looking for. Painting it as a problem makes a working session look broken.
    assert.strictEqual(statusTone(404), 'info');
    assert.strictEqual(statusTone(500), 'bad');
  });

  test('a size and a round trip wear the same three tones, on their own scales', (assert) => {
    assert.strictEqual(sizeTone(99_999), 'good');
    assert.strictEqual(sizeTone(100_000), 'warn', 'a terminal stops being comfortable here');
    assert.strictEqual(sizeTone(1_000_000), 'bad');

    assert.strictEqual(durationTone(99), 'good');
    assert.strictEqual(durationTone(100), 'warn', 'where a person starts to notice waiting');
    assert.strictEqual(durationTone(1_000), 'bad', 'and where they start doing something else');
  });

  test('a status with no reason phrase says just the number', (assert) => {
    const line = printStatus(
      buildRespondedHttpRequest({ status: 204, statusText: '', bytes: 0 }, 3),
      plain,
    );

    assert.includes(line, '204');
    assert.notIncludes(line, 'undefined', 'a missing reason phrase is absent, not printed');
  });

  test('a body that was cut says so in the size', (assert) => {
    const cut = buildRespondedHttpRequest(
      { status: 200, statusText: 'OK', bytes: 5_000, bodyTruncated: true },
      8,
    );

    assert.includes(printStatus(cut, plain), '4.9 KB+', 'the plus is the whole notice');
  });

  test('a failure is the failure, not a status', (assert) => {
    const line = printStatus(buildRefusedHttpRequest('connection refused'), plain);

    assert.includes(line, 'connection refused');
    assert.notIncludes(line, '200');
    assert.notIncludes(line, '#', 'an connection nothing kept has no name to give');
  });

  test('headers are sorted, because a block is looked through and not read', (assert) => {
    const drawn = printHeaders(
      new Map([
        ['x-total', '2'],
        ['content-type', 'application/json'],
      ]),
      plain,
    );

    assert.strictEqual(drawn, 'content-type: application/json\nx-total: 2');
  });

  test('no headers draws nothing, and the caller says it in words', (assert) => {
    assert.strictEqual(printHeaders(new Map(), plain), '');
  });

  test('the name is what a block is looked through for, so the name is what is painted', (assert) => {
    // Colour is off under a test runner, so what is provable here is the shape: the name, a
    // colon, then the value. Which colour it wears is `blue` — the same one a URL wears.
    assert.strictEqual(printHeaders(new Map([['a', '1']]), plain), 'a: 1');
  });
});

module('Commands | repl | drawing a body', { concurrency: true }, () => {
  test('JSON is re-indented, because an API answers a machine and this is not one', (assert) => {
    assert.strictEqual(
      printBody(buildJSONHttpRequestWithBody('{"a":1}'), plain, Infinity),
      '{\n  "a": 1\n}',
    );
  });

  test('a body that claims JSON and is not comes through untouched', (assert) => {
    assert.strictEqual(
      printBody(buildJSONHttpRequestWithBody('not json at all'), plain, Infinity),
      'not json at all',
    );
  });

  test('anything else is left exactly as it arrived', (assert) => {
    const html = buildHttpRequestWithBody('<p>hi</p>', 'text/html');

    assert.strictEqual(printBody(html, plain, Infinity), '<p>hi</p>');
  });

  test('an empty body says it is empty rather than printing nothing', (assert) => {
    assert.includes(
      printBody(buildHttpRequestWithBody('', 'text/plain'), plain, Infinity),
      '<empty>',
    );
  });

  test('bytes are described, never printed — a terminal handed a PNG loses its cursor', (assert) => {
    const image: Response = {
      status: 200,
      statusText: 'OK',
      headers: new Map([['content-type', 'image/png']]),
      body: '',
      bytes: 3_000,
      bodyTruncated: false,
      binary: true,
    };
    const drawn = printBody(image, plain, Infinity);

    assert.includes(drawn, '2.9 KB');
    assert.includes(drawn, 'image/png');
    assert.includes(drawn, 'not shown');
  });

  test('a long body stops at the limit and names what shows the rest', (assert) => {
    const long = buildHttpRequestWithBody(
      Array.from({ length: 100 }, (_, at) => `line ${at}`).join('\n'),
      'text/plain',
    );
    const drawn = printBody(long, plain, 10);

    assert.includes(drawn, 'line 9');
    assert.notIncludes(drawn, 'line 10\n', 'ten lines is ten lines');
    assert.includes(drawn, '90 more lines');
    assert.includes(drawn, '.request body', 'and the spelling that shows them');
  });

  test('one enormous line is cut by characters, since it has no lines to count', (assert) => {
    const minified = buildHttpRequestWithBody('x'.repeat(20_000), 'text/plain');
    const drawn = printBody(minified, plain, 40);

    assert.true(drawn.length < 6_000, 'a minified bundle does not become the whole screen');
    assert.includes(drawn, 'the rest');
  });

  test('no limit is the whole thing, which is what `.request … body` asks for', (assert) => {
    const long = buildHttpRequestWithBody(
      Array.from({ length: 100 }, (_, at) => `line ${at}`).join('\n'),
      'text/plain',
    );

    assert.includes(printBody(long, plain, Infinity), 'line 99');
    assert.notIncludes(printBody(long, plain, Infinity), 'more lines');
  });

  test('a body cut at the cap says where it stopped when asked for all of it', (assert) => {
    const cut = {
      ...buildHttpRequestWithBody('half of it', 'text/plain'),
      bytes: 2_000_000,
      bodyTruncated: true,
    };

    assert.includes(printBody(cut, plain, Infinity), 'stopped at 1.9 MB');
  });
});

module('Commands | repl | drawing the whole connection', { concurrency: true }, () => {
  test('everything about it, in the order it happened', (assert) => {
    const connection: HttpRequest = {
      request: {
        verb: 'POST',
        url: 'http://x/api/users',
        headers: new Map([['accept', '*/*']]),
        body: '{"name":"Ada"}',
      },
      response: buildJSONHttpRequestWithBody('{"id":1}'),
      failed: null,
      ms: 12,
      at: Date.now(),
    };
    const drawn = printRequest(connection, plain);

    assert.includes(drawn, '200 OK', 'the answer leads');
    assert.includes(drawn, '| POST http://x/api/users', 'naming the request it answered');
    // No caption, and no gap: the headers of the request hang off the line that names it.
    assert.includes(drawn, 'http://x/api/users\naccept: */*', 'what was sent, under what sent it');
    assert.includes(drawn, '\n\n{"name":"Ada"}', 'the body it carried, a block of its own');
    assert.includes(drawn, '"id": 1', 'and last, what came back');
    assert.notIncludes(drawn, 'sent headers', 'a blank line already says a block is a block');
    assert.true(
      drawn.indexOf('200 OK') < drawn.indexOf('accept: */*'),
      'the status is the headline, not a footnote under the request',
    );
  });

  test('a request that never got a reply says only what there is to say', (assert) => {
    const drawn = printRequest(buildRefusedHttpRequest('no such host'), plain);

    assert.includes(drawn, 'no such host');
    assert.notIncludes(drawn, '<empty>', 'there is no body to call empty');
  });

  test('one line each, for a list of them', (assert) => {
    const now = Date.now();
    const line = printRequestLine(
      {
        ...buildRespondedHttpRequest({ status: 404, statusText: 'Not Found', bytes: 4 }, 3),
        at: now - 65_000,
      },
      plain,
      now,
    );

    assert.includes(line, '1m ago');
    assert.includes(line, 'GET');
    assert.includes(line, '404');
  });

  test('a failure in a list is dashes, since there is no status to show', (assert) => {
    assert.includes(printRequestLine(buildRefusedHttpRequest('refused'), plain, Date.now()), '---');
  });

  test('how long ago, in the shortest true words', (assert) => {
    assert.strictEqual(agoInWords(200), 'just now');
    assert.strictEqual(agoInWords(12_000), '12s ago');
    assert.strictEqual(agoInWords(240_000), '4m ago');
    assert.strictEqual(agoInWords(7_200_000), '2h ago');
  });
});

/** The request half, which most of these do not care about beyond its verb and URL. */
function buildBasicHttpRequest(verb: string, url: string): HttpRequest['request'] {
  return { verb, url, headers: new Map(), body: null };
}

/** A response of a given type, with the fields nothing here varies left at their quiet defaults. */
function buildHttpRequestWithBody(text: string, type: string): Response {
  return {
    status: 200,
    statusText: 'OK',
    headers: new Map([['content-type', type]]),
    body: text,
    bytes: text.length,
    bodyTruncated: false,
    binary: false,
  };
}

/** A JSON response, which is the one most of the body tests are about. */
function buildJSONHttpRequestWithBody(text: string): Response {
  return buildHttpRequestWithBody(text, 'application/json');
}

/** A request that got a reply, described by the parts a status line reads. */
function buildRespondedHttpRequest(
  answered: { status: number; statusText: string; bytes: number; bodyTruncated?: boolean },
  ms: number,
): HttpRequest {
  return {
    id: 4,
    request: buildBasicHttpRequest('GET', 'http://x/y'),
    response: {
      status: answered.status,
      statusText: answered.statusText,
      headers: new Map([['content-type', 'text/plain']]),
      body: 'body',
      bytes: answered.bytes,
      bodyTruncated: answered.bodyTruncated ?? false,
      binary: false,
    },
    failed: null,
    ms,
    at: Date.now(),
  };
}

/** A request that never got one. */
function buildRefusedHttpRequest(why: string): HttpRequest {
  // `id: 0` — nothing kept this one, so it has no name to print.
  return {
    id: 0,
    request: buildBasicHttpRequest('GET', 'http://x/y'),
    response: null,
    failed: why,
    ms: 2,
    at: Date.now(),
  };
}
