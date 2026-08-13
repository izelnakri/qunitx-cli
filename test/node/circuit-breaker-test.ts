import { module, test } from 'qunitx';
import { circuitBreaker } from '../../lib/node/index.ts';
import { Failure, isFailure } from '../../lib/result/failure.ts';

const fail = () => Promise.reject(new Error('down'));
const ok = () => Promise.resolve('ok');

module('Node | circuit breaker', { concurrency: true }, () => {
  test('trips open after maxFailures consecutive failures, then fails fast', async (assert) => {
    const clock = { t: 0 };
    const cb = circuitBreaker({ maxFailures: 3, resetTimeoutMs: 100, now: () => clock.t });

    for (let i = 0; i < 3; i++) await cb.run(fail).catch(() => {});
    assert.equal(cb.state(), 'open', 'three failures trip it');

    // While open, calls reject IMMEDIATELY with a declared CircuitOpen — op never runs.
    let ran = false;
    const rejection = await cb
      .run(() => {
        ran = true;
        return ok();
      })
      .then(
        () => null,
        (e) => e,
      );
    assert.false(ran, 'the guarded op is not even called while open');
    assert.true(
      isFailure(rejection) && (rejection as Failure).code === 'CircuitOpen',
      'fast-fail is a CircuitOpen failure',
    );
  });

  test('half-open probe closes on success', async (assert) => {
    const clock = { t: 0 };
    const cb = circuitBreaker({ maxFailures: 2, resetTimeoutMs: 100, now: () => clock.t });
    await cb.run(fail).catch(() => {});
    await cb.run(fail).catch(() => {});
    assert.equal(cb.state(), 'open');

    clock.t = 150; // cooldown elapsed → next call is a half-open probe
    const value = await cb.run(ok);
    assert.equal(value, 'ok', 'the probe ran and returned');
    assert.equal(cb.state(), 'closed', 'a successful probe closes the breaker');
  });

  test('half-open probe re-opens on failure and restarts the cooldown', async (assert) => {
    const clock = { t: 0 };
    const cb = circuitBreaker({ maxFailures: 1, resetTimeoutMs: 100, now: () => clock.t });
    await cb.run(fail).catch(() => {});
    assert.equal(cb.state(), 'open');

    clock.t = 100; // half-open window
    await cb.run(fail).catch(() => {});
    assert.equal(cb.state(), 'open', 'a failed probe trips straight back to open');

    // Still within the fresh cooldown → fast-fail again.
    clock.t = 150;
    const rejection = await cb.run(ok).then(
      () => null,
      (e) => e,
    );
    assert.true(
      isFailure(rejection) && (rejection as Failure).code === 'CircuitOpen',
      'cooldown restarted from the failed probe',
    );
  });

  test('shouldTrip ignores expected failures — a NotFound never trips the wire', async (assert) => {
    const cb = circuitBreaker({
      maxFailures: 2,
      shouldTrip: (e) => !(isFailure(e) && (e as Failure).code === 'NotFound'),
    });
    const notFound = () => Promise.reject(new Failure('NotFound', 'nope', {}));
    for (let i = 0; i < 5; i++) await cb.run(notFound).catch(() => {});
    assert.equal(cb.state(), 'closed', 'expected failures do not count toward tripping');
  });

  test('a success resets the consecutive-failure count', async (assert) => {
    const cb = circuitBreaker({ maxFailures: 3 });
    await cb.run(fail).catch(() => {});
    await cb.run(fail).catch(() => {});
    await cb.run(ok); // resets the streak
    await cb.run(fail).catch(() => {});
    await cb.run(fail).catch(() => {});
    assert.equal(cb.state(), 'closed', 'the interleaved success cleared the count');
  });

  test('reset() forces the breaker closed', async (assert) => {
    const cb = circuitBreaker({ maxFailures: 1 });
    await cb.run(fail).catch(() => {});
    assert.equal(cb.state(), 'open');
    cb.reset();
    assert.equal(cb.state(), 'closed', 'manual reset re-closes it');
  });
});
