import { module, test } from 'qunitx';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import * as Failure from '../../lib/result/failure.ts';

const FileMissing = Failure.define(
  'FileMissing',
  (data: { path: string }) => `no such file: ${data.path}`,
);
const Timeout = Failure.define('Timeout', 'operation timed out');

// ── define ────────────────────────────────────────────────────────────────────

module('Result | Failure | define', { concurrency: true }, () => {
  test('a defined failure carries its code, message and payload', (assert) => {
    const failure = FileMissing({ path: 'a.ts' });
    assert.strictEqual(failure.code, 'FileMissing');
    assert.strictEqual(failure.message, 'no such file: a.ts');
    assert.deepEqual(failure.data, { path: 'a.ts' });
  });

  test('a payload-free failure takes a static message and no argument', (assert) => {
    const failure = Timeout();
    assert.strictEqual(failure.code, 'Timeout');
    assert.strictEqual(failure.message, 'operation timed out');
    assert.strictEqual(failure.data, undefined);
  });

  test('the factory exposes its code, so registries never restate the string', (assert) => {
    assert.strictEqual(FileMissing.code, 'FileMissing');
  });

  test('it is a real Error, so every logger and inspector already handles it', (assert) => {
    const failure = FileMissing({ path: 'a.ts' });
    assert.true(failure instanceof Error);
    assert.strictEqual(failure.name, 'Failure(FileMissing)');
    assert.true(typeof failure.stack === 'string' && failure.stack.length > 0);
  });

  test('the stack starts at the reporting code, not inside the factory', (assert) => {
    const firstFrame = FileMissing({ path: 'a.ts' }).stack?.split('\n')[1] ?? '';
    assert.false(firstFrame.includes('failure.ts'), 'constructor frames are elided');
  });

  test('stackless skips the trace for failures produced in a hot loop', (assert) => {
    const failure = Timeout(undefined, { stackless: true });
    assert.strictEqual(failure.stack, 'Failure(Timeout): operation timed out');
  });

  test('stackAnchor elides a wrapper around the factory from the trace', (assert) => {
    function wrapper(path: string) {
      return FileMissing({ path }, { stackAnchor: wrapper });
    }
    const firstFrame = wrapper('a.ts').stack?.split('\n')[1] ?? '';
    assert.false(firstFrame.includes('wrapper'), 'the anchored wrapper frame is elided');
  });

  test('cause is the spec-defined own property, not a bag field', (assert) => {
    const original = new Error('EACCES');
    const failure = FileMissing({ path: 'a.ts' }, { cause: original });
    assert.strictEqual(failure.cause, original);
    assert.true(Object.hasOwn(failure, 'cause'));
  });
});

// ── Guards ────────────────────────────────────────────────────────────────────

module('Result | Failure | is', { concurrency: true }, () => {
  test('the factory guard matches only its own code', (assert) => {
    assert.true(FileMissing.is(FileMissing({ path: 'a' })));
    assert.false(FileMissing.is(Timeout()));
    assert.false(FileMissing.is(new Error('boom')));
    assert.false(FileMissing.is(null));
  });

  test('a Failure built in another realm is still recognised', (assert) => {
    // What `instanceof` cannot do. A Worker, an iframe and a vm context each have their own
    // `Failure` binding and their own `Error.prototype`; the Symbol.for brand is shared
    // because the symbol registry is per-process, not per-realm.
    const foreign = Object.create(Error.prototype);
    Object.assign(foreign, { code: 'FileMissing', message: 'no such file: a' });
    Object.defineProperty(foreign, Symbol.for('result.Failure'), { value: true });
    assert.true(Failure.is(foreign));
    assert.true(FileMissing.is(foreign));
  });

  test('toJSON output revived by plain JSON.parse is still recognised', (assert) => {
    const revived = JSON.parse(JSON.stringify(Failure.toJSON(FileMissing({ path: 'a' }))));
    assert.true(Failure.is(revived));
  });

  test('a Node system error is NOT mistaken for a Failure', (assert) => {
    // Every errno error has a string `code` and a string `message`, so a purely structural
    // check would report `true` here and `error.data` would silently read undefined onwards.
    const enoent = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    assert.false(Failure.is(enoent));
  });

  test('hasCode narrows across several codes at once', (assert) => {
    assert.true(Failure.hasCode(FileMissing({ path: 'a' }), 'FileMissing', 'Timeout'));
    assert.false(Failure.hasCode(Timeout(), 'FileMissing'));
    assert.false(Failure.hasCode('not a failure', 'FileMissing'));
  });
});

// ── from ──────────────────────────────────────────────────────────────────────

module('Result | Failure | from', { concurrency: true }, () => {
  test('an existing Failure passes through by identity', (assert) => {
    const failure = Timeout();
    assert.strictEqual(Failure.from(failure), failure);
  });

  test('an Error becomes Unknown with the original preserved as cause', (assert) => {
    const boom = new Error('boom');
    const failure = Failure.from(boom);
    assert.strictEqual(failure.code, 'Unknown');
    assert.strictEqual(failure.message, 'boom');
    assert.strictEqual(failure.cause, boom);
  });

  test('every legal non-Error throwable is normalised without losing the value', (assert) => {
    // `throw 'nope'`, `throw undefined` and `throw null` are all legal JS and all occur in
    // the wild — most often as `Promise.reject(someNonError)` from a DOM or legacy callback.
    for (const thrown of ['nope', undefined, null, 42, Symbol('s'), { code: 42 }]) {
      const failure = Failure.from(thrown);
      assert.strictEqual(failure.code, 'Unknown');
      assert.strictEqual(failure.cause, thrown);
    }
  });
});

// ── Cause chains ──────────────────────────────────────────────────────────────

module('Result | Failure | causes', { concurrency: true }, () => {
  test('causes walks the chain outermost first', (assert) => {
    const root = new Error('EACCES');
    const middle = FileMissing({ path: 'a.ts' }, { cause: root });
    const outer = Timeout(undefined, { cause: middle });
    assert.deepEqual(Failure.causes(outer), [outer, middle, root]);
    assert.strictEqual(Failure.rootCause(outer), root);
  });

  test('a cyclic cause chain terminates instead of hanging the formatter', (assert) => {
    // Entirely constructible, and a logger is the last place that should be able to lock up
    // a process.
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    assert.strictEqual(Failure.causes(a).length, 2);
  });

  test('an unbounded chain is depth-capped', (assert) => {
    let error = new Error('root');
    for (let i = 0; i < 100; i++) error = new Error(`link ${i}`, { cause: error });
    assert.strictEqual(Failure.causes(error).length, 32);
  });

  test('format renders the whole chain as indented lines', (assert) => {
    const failure = Timeout(undefined, { cause: FileMissing({ path: 'a.ts' }) });
    assert.strictEqual(
      Failure.format(failure),
      ['Timeout: operation timed out', '  caused by: FileMissing: no such file: a.ts'].join('\n'),
    );
  });

  test('format handles a non-Error link in the chain', (assert) => {
    assert.strictEqual(Failure.format('just a string'), '"just a string"');
    assert.strictEqual(Failure.format(null), '');
  });
});

// ── Serialization ─────────────────────────────────────────────────────────────

module('Result | Failure | serialization', { concurrency: true }, () => {
  test('a bare Error stringifies to {} — the problem toJSON exists to solve', (assert) => {
    // `message` and `stack` are own-but-non-enumerable and `name` lives on the prototype, so
    // an error shipped over a WebSocket arrives as an empty object.
    assert.strictEqual(JSON.stringify(new Error('boom')), '{}');
  });

  test('toJSON keeps code, message, data and stack', (assert) => {
    const wire = Failure.toJSON(FileMissing({ path: 'a.ts' }));
    assert.true(wire.failure);
    assert.strictEqual(wire.code, 'FileMissing');
    assert.strictEqual(wire.message, 'no such file: a.ts');
    assert.deepEqual(wire.data, { path: 'a.ts' });
    assert.true(typeof wire.stack === 'string');
  });

  test('a Failure stringifies through its own toJSON with no ceremony', (assert) => {
    const parsed = JSON.parse(JSON.stringify(FileMissing({ path: 'a.ts' })));
    assert.strictEqual(parsed.code, 'FileMissing');
    assert.deepEqual(parsed.data, { path: 'a.ts' });
  });

  test('a round trip reconstructs the failure and its cause chain', (assert) => {
    const original = Timeout(undefined, {
      cause: FileMissing({ path: 'a.ts' }, { cause: new Error('EACCES') }),
    });
    const revived = Failure.fromJSON(JSON.parse(JSON.stringify(Failure.toJSON(original))));

    assert.strictEqual(revived.code, 'Timeout');
    assert.true(Failure.is(revived));
    const chain = Failure.causes(revived);
    assert.strictEqual(chain.length, 3);
    assert.strictEqual((chain[1] as Failure.Any).code, 'FileMissing');
    assert.strictEqual((chain[2] as Error).message, 'EACCES');
  });

  test('the revived stack is the remote stack, not this process', (assert) => {
    const wire = Failure.toJSON(FileMissing({ path: 'a.ts' }));
    wire.stack = 'Failure(FileMissing): no such file: a.ts\n    at browser.js:1:1';
    assert.true(Failure.fromJSON(wire).stack?.includes('browser.js'));
  });

  test('unserializable payload fields fail at the boundary, not in the caller', (assert) => {
    // A circular reference, a function or a BigInt inside `data` would otherwise throw from
    // inside the caller's JSON.stringify — replacing the error being reported with a new one.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const Weird = Failure.define('Weird', (_data: unknown) => 'weird');
    assert.deepEqual(Failure.toJSON(Weird(circular)).data, { unserializable: '[object Object]' });
    assert.deepEqual(Failure.toJSON(Weird({ n: 1n })).data, { unserializable: '[object Object]' });
  });

  test('structuredClone is NOT a substitute — it drops code and data', (assert) => {
    // Documented explicitly because the failure mode is silent: the clone is still an Error
    // with the right message, so nothing looks wrong until `error.code` reads undefined.
    const cloned = structuredClone(FileMissing({ path: 'a.ts' }));
    assert.strictEqual((cloned as { code?: string }).code, undefined);
    assert.false(Failure.is(cloned));
  });
});

// ── Observability: setDebug + onIgnored — the seams for hosts and future packaging ──

module('Result | Failure | ignore observability', { concurrency: true }, () => {
  test('onIgnored sees every ignored failure, with its label — and detaches cleanly', (assert) => {
    const seen: { context: string; error: unknown }[] = [];
    Failure.onIgnored((context, error) => seen.push({ context, error }));
    try {
      const boom = new Error('EBUSY');
      Failure.ignore('observed unlink')(boom);
      const mine = seen.filter((s) => s.context === 'observed unlink');
      assert.strictEqual(mine.length, 1);
      assert.strictEqual(mine[0].error, boom, 'the original error, by identity');
    } finally {
      Failure.onIgnored(null);
    }
    Failure.ignore('after detach')(new Error('x'));
    assert.strictEqual(
      seen.filter((s) => s.context === 'after detach').length,
      0,
      'a detached observer sees nothing',
    );
  });

  test('setDebug(true) reports on stderr at runtime; setDebug(false) silences again', (assert) => {
    const written: string[] = [];
    const realWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => (written.push(String(chunk)), true)) as never;
    try {
      Failure.setDebug(true);
      Failure.ignore('debug toggled on')(new Error('EPERM'));
      Failure.setDebug(false);
      Failure.ignore('debug toggled off')(new Error('EPERM'));
    } finally {
      process.stderr.write = realWrite;
      Failure.setDebug(Boolean(process.env.QUNITX_DEBUG));
    }
    assert.true(
      written.some((line) => line.includes('ignored (debug toggled on): Error: EPERM')),
      'the labelled report reached stderr while enabled',
    );
    assert.false(
      written.some((line) => line.includes('debug toggled off')),
      'silent again after setDebug(false)',
    );
  });

  test('ignored failures publish to the platform diagnostics_channel — any number of subscribers', (assert) => {
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    const subA = (message: unknown) => seenA.push(message);
    const subB = (message: unknown) => seenB.push(message);
    subscribe(Failure.IGNORED_CHANNEL_NAME, subA);
    subscribe(Failure.IGNORED_CHANNEL_NAME, subB);
    try {
      const boom = new Error('EBUSY');
      Failure.ignore('channel unlink')(boom);
      assert.deepEqual(seenA, [{ context: 'channel unlink', error: boom }]);
      assert.deepEqual(seenB, seenA, 'both subscribers see the same event — no single-slot limit');
    } finally {
      unsubscribe(Failure.IGNORED_CHANNEL_NAME, subA);
      unsubscribe(Failure.IGNORED_CHANNEL_NAME, subB);
    }
    Failure.ignore('after unsubscribe')(new Error('x'));
    assert.strictEqual(seenA.length, 1, 'unsubscribed channels see nothing further');
  });
});

// ── Tracing: attributes + the observed seam ──────────────────────────────────

module('Result | Failure | tracing', { concurrency: true }, () => {
  const AuthFailed = Failure.define(
    'AuthFailed',
    (d: { status: number; password: string }) => `auth rejected: HTTP ${d.status}`,
    { trace: (d) => ({ 'auth.status': d.status }) },
  );

  test('attributes returns the code plus only what the trace mapper allowlisted', (assert) => {
    const attrs = Failure.attributes(AuthFailed({ status: 401, password: 'hunter2' }));
    assert.deepEqual(attrs, { 'failure.code': 'AuthFailed', 'auth.status': 401 });
    assert.false(
      JSON.stringify(attrs).includes('hunter2'),
      'the unmapped field cannot leak — redaction by omission',
    );
  });

  test('a kind with no trace mapper yields the code alone — safe default', (assert) => {
    assert.deepEqual(Failure.attributes(FileMissing({ path: 'secret/x.ts' })), {
      'failure.code': 'FileMissing',
    });
  });

  test('attributes resolves by code, so a fromJSON-revived failure still maps', (assert) => {
    const revived = Failure.fromJSON(
      JSON.parse(JSON.stringify(AuthFailed({ status: 503, password: 'x' }))),
    );
    assert.deepEqual(Failure.attributes(revived), {
      'failure.code': 'AuthFailed',
      'auth.status': 503,
    });
  });

  test('observed() reports to the portable observer and the diagnostics_channel', (assert) => {
    const viaHook: string[] = [];
    const viaChannel: unknown[] = [];
    const sub = (message: unknown) => viaChannel.push(message);
    Failure.onObserved((failure) => viaHook.push(failure.code));
    subscribe(Failure.OBSERVED_CHANNEL_NAME, sub);
    try {
      const failure = AuthFailed({ status: 401, password: 'x' });
      Failure.observed(failure);
      assert.deepEqual(viaHook, ['AuthFailed']);
      assert.deepEqual(viaChannel, [{ error: failure }]);
    } finally {
      Failure.onObserved(null);
      unsubscribe(Failure.OBSERVED_CHANNEL_NAME, sub);
    }
    Failure.observed(AuthFailed({ status: 500, password: 'x' }));
    assert.strictEqual(viaHook.length, 1, 'a detached observer sees nothing further');
  });
});
