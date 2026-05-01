import { module, test } from 'qunitx';
import {
  parseDaemonIdleTimeout,
  DEFAULT_DAEMON_IDLE_TIMEOUT_MS,
} from '../../lib/utils/parse-daemon-idle-timeout.ts';
import '../helpers/custom-asserts.ts';

const MIN = 60_000;
const HOUR = 3_600_000;

module('Utils | parseDaemonIdleTimeout | defaults', { concurrency: true }, () => {
  test('undefined → default ms, no warning', (assert) => {
    const r = parseDaemonIdleTimeout(undefined);
    assert.strictEqual(r.ms, DEFAULT_DAEMON_IDLE_TIMEOUT_MS);
    assert.strictEqual(r.warning, null);
  });

  test('empty string → default ms, no warning', (assert) => {
    const r = parseDaemonIdleTimeout('');
    assert.strictEqual(r.ms, DEFAULT_DAEMON_IDLE_TIMEOUT_MS);
    assert.strictEqual(r.warning, null);
  });

  test('DEFAULT_DAEMON_IDLE_TIMEOUT_MS is 30 minutes', (assert) => {
    assert.strictEqual(DEFAULT_DAEMON_IDLE_TIMEOUT_MS, 30 * 60 * 1000);
  });
});

module('Utils | parseDaemonIdleTimeout | bare numbers (minutes)', { concurrency: true }, () => {
  test('"30" → 30 minutes', (assert) => {
    assert.strictEqual(parseDaemonIdleTimeout('30').ms, 30 * MIN);
  });

  test('"1" → 1 minute', (assert) => {
    assert.strictEqual(parseDaemonIdleTimeout('1').ms, 1 * MIN);
  });

  test('fractional bare number ("0.5" → 30s)', (assert) => {
    assert.strictEqual(parseDaemonIdleTimeout('0.5').ms, 30_000);
  });
});

module('Utils | parseDaemonIdleTimeout | unit suffixes', { concurrency: true }, () => {
  test('ms suffix is taken literally', (assert) => {
    assert.strictEqual(parseDaemonIdleTimeout('500ms').ms, 500);
    assert.strictEqual(parseDaemonIdleTimeout('1ms').ms, 1);
  });

  test('s suffix is seconds', (assert) => {
    assert.strictEqual(parseDaemonIdleTimeout('45s').ms, 45_000);
  });

  test('m suffix is minutes (matches the default-unit interpretation)', (assert) => {
    assert.strictEqual(parseDaemonIdleTimeout('30m').ms, parseDaemonIdleTimeout('30').ms);
    assert.strictEqual(parseDaemonIdleTimeout('30m').ms, 30 * MIN);
  });

  test('h suffix is hours; fractional hours work', (assert) => {
    assert.strictEqual(parseDaemonIdleTimeout('1h').ms, HOUR);
    assert.strictEqual(parseDaemonIdleTimeout('0.5h').ms, 30 * MIN);
  });

  test('uppercase suffixes parse the same as lowercase', (assert) => {
    assert.strictEqual(parseDaemonIdleTimeout('30M').ms, 30 * MIN);
    assert.strictEqual(parseDaemonIdleTimeout('1H').ms, HOUR);
    assert.strictEqual(parseDaemonIdleTimeout('500MS').ms, 500);
  });

  test('whitespace around value and unit is tolerated', (assert) => {
    assert.strictEqual(parseDaemonIdleTimeout('  30m  ').ms, 30 * MIN);
    assert.strictEqual(parseDaemonIdleTimeout('30 m').ms, 30 * MIN);
    assert.strictEqual(parseDaemonIdleTimeout(' 1 h ').ms, HOUR);
  });
});

module('Utils | parseDaemonIdleTimeout | "false" → infinite', { concurrency: true }, () => {
  test('"false" → Infinity, no warning', (assert) => {
    const r = parseDaemonIdleTimeout('false');
    assert.strictEqual(r.ms, Infinity);
    assert.strictEqual(r.warning, null);
  });

  test('"FALSE" / "  false  " also parse as infinite (case + whitespace tolerant)', (assert) => {
    assert.strictEqual(parseDaemonIdleTimeout('FALSE').ms, Infinity);
    assert.strictEqual(parseDaemonIdleTimeout('  false  ').ms, Infinity);
    assert.strictEqual(parseDaemonIdleTimeout('False').ms, Infinity);
  });

  test('Infinity result is non-finite (Number.isFinite gates the daemon timer)', (assert) => {
    // Mirrors the guard in resetIdleTimer: !Number.isFinite(IDLE_TIMEOUT_MS) ⇒ no setTimeout.
    assert.false(Number.isFinite(parseDaemonIdleTimeout('false').ms));
  });
});

module(
  'Utils | parseDaemonIdleTimeout | invalid input → default + warning',
  { concurrency: true },
  () => {
    const cases = [
      { input: 'abc', label: 'non-numeric' },
      { input: '0', label: 'zero (bare)' },
      { input: '0m', label: 'zero with unit' },
      { input: '-5', label: 'negative (regex rejects sign)' },
      { input: '30x', label: 'unknown suffix' },
      { input: '5.', label: 'trailing dot, no fraction digits' },
      { input: '.5', label: 'leading dot, no integer digits' },
      { input: '30 minutes', label: 'spelled-out unit' },
      { input: 'true', label: 'bool-like other than "false"' },
    ];

    for (const { input, label } of cases) {
      test(`"${input}" (${label}) → default ms + warning`, (assert) => {
        const r = parseDaemonIdleTimeout(input);
        assert.strictEqual(r.ms, DEFAULT_DAEMON_IDLE_TIMEOUT_MS, 'falls back to default');
        assert.ok(r.warning, 'warning is set');
        assert.ok(r.warning?.includes('QUNITX_DAEMON_IDLE_TIMEOUT'), 'warning names the env var');
        assert.ok(r.warning?.includes(JSON.stringify(input)), 'warning quotes the bad value');
      });
    }

    test('warning text lists every accepted form so the user can self-correct', (assert) => {
      // One snapshot of the error message — if the accepted-formats list ever drifts
      // out of sync with the actual parser, this assertion catches it.
      const r = parseDaemonIdleTimeout('garbage');
      const w = r.warning ?? '';
      for (const example of ['"30m"', '"1h"', '"45s"', '"500ms"', '"false"', 'minutes']) {
        assert.ok(w.includes(example), `warning mentions ${example}`);
      }
    });
  },
);
