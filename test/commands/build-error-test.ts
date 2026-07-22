import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as Result from '../../lib/result/index.ts';
import '../helpers/custom-asserts.ts';
import {
  buildTestBundle,
  deriveBuildErrorType,
  formatBuildErrors,
} from '../../lib/commands/run/tests-in-browser.ts';
import * as WebServer from '../../lib/setup/web-server.ts';
import * as RunState from '../../lib/setup/run-state.ts';
import type { Config } from '../../lib/types.ts';

const CWD = process.cwd();

// ---------------------------------------------------------------------------
// deriveBuildErrorType
// ---------------------------------------------------------------------------

module('Commands | deriveBuildErrorType', { concurrency: true }, () => {
  test('returns "Module Resolution Error" for esbuild "Could not resolve" messages', (assert) => {
    const error = {
      errors: [{ text: 'Could not resolve "missing-module"', location: null, notes: [] }],
    };
    assert.equal(deriveBuildErrorType(error), 'Module Resolution Error');
  });

  test('returns "Module Resolution Error" when the plain error message matches', (assert) => {
    assert.equal(
      deriveBuildErrorType(new Error('Could not resolve "foo"')),
      'Module Resolution Error',
    );
  });

  test('returns "Syntax Error" for unexpected-token messages', (assert) => {
    const error = { errors: [{ text: 'Unexpected token "}"', location: null, notes: [] }] };
    assert.equal(deriveBuildErrorType(error), 'Syntax Error');
  });

  test('returns "Reference Error" for "is not defined" messages', (assert) => {
    const error = { errors: [{ text: 'foo is not defined', location: null, notes: [] }] };
    assert.equal(deriveBuildErrorType(error), 'Reference Error');
  });

  test('returns "Build Error" for unrecognized error text', (assert) => {
    assert.equal(deriveBuildErrorType(new Error('something completely unknown')), 'Build Error');
  });

  test('prefers the structured errors array over the Error message', (assert) => {
    // The Error message would match "Module Resolution Error", but the structured
    // errors array says "Unexpected token" — the structured message wins.
    const error = Object.assign(new Error('Could not resolve "foo"'), {
      errors: [{ text: 'Unexpected token', location: null, notes: [] }],
    });
    assert.equal(deriveBuildErrorType(error), 'Syntax Error');
  });
});

// ---------------------------------------------------------------------------
// formatBuildErrors
// ---------------------------------------------------------------------------

module('Commands | formatBuildErrors', { concurrency: true }, () => {
  test('formats a structured message with file location and caret line', (assert) => {
    const error = {
      errors: [
        {
          text: 'Could not resolve "missing"',
          location: {
            file: 'test/foo.ts',
            line: 3,
            column: 7,
            length: 9,
            lineText: 'import x from "missing"',
          },
          notes: [],
        },
      ],
    };
    const result = formatBuildErrors(error);
    assert.ok(result.includes('[1] Could not resolve "missing"'), 'numbered error header present');
    assert.ok(result.includes('test/foo.ts:3:7'), 'file:line:col reference present');
    assert.ok(
      result.includes('3 \u2502 import x from "missing"'),
      'source line with gutter present',
    );
    assert.ok(result.includes('~~~~~~~~~'), 'caret underline present');
  });

  test('omits location lines when location is null', (assert) => {
    const error = { errors: [{ text: 'Generic build failure', location: null, notes: [] }] };
    const result = formatBuildErrors(error);
    assert.ok(result.includes('[1] Generic build failure'), 'error text present');
    assert.notOk(result.includes('\u2502'), 'no gutter line when location is absent');
  });

  test('appends note text when notes are present', (assert) => {
    const error = {
      errors: [
        {
          text: 'Some error',
          location: null,
          notes: [{ text: 'Try installing the package' }, { text: '' }],
        },
      ],
    };
    const result = formatBuildErrors(error);
    assert.ok(result.includes('    Note: Try installing the package'), 'non-empty note appended');
    assert.notOk(result.includes('    Note: \n'), 'empty note not appended');
  });

  test('formats multiple errors with sequential numbering and blank-line separation', (assert) => {
    const error = {
      errors: [
        { text: 'First error', location: null, notes: [] },
        { text: 'Second error', location: null, notes: [] },
      ],
    };
    const result = formatBuildErrors(error);
    assert.ok(result.includes('[1] First error'), 'first error numbered');
    assert.ok(result.includes('[2] Second error'), 'second error numbered');
    assert.ok(result.includes('\n\n'), 'errors separated by a blank line');
  });

  test('strips ANSI escape codes from a plain Error fallback', (assert) => {
    const error = new Error('\x1b[31mred error text\x1b[0m');
    const result = formatBuildErrors(error);
    assert.notOk(result.includes('\x1b'), 'ANSI codes stripped');
    assert.ok(result.includes('red error text'), 'visible text preserved');
  });

  test('uses the structured errors array when available even on Error instances', (assert) => {
    const error = Object.assign(new Error('plain message'), {
      errors: [{ text: 'Structured message', location: null, notes: [] }],
    });
    const result = formatBuildErrors(error);
    assert.ok(result.includes('[1] Structured message'), 'structured array used');
    assert.notOk(result.includes('plain message'), 'plain Error.message ignored');
  });
});

// ---------------------------------------------------------------------------
// buildErrorHTML
// ---------------------------------------------------------------------------

module('Setup | buildErrorHTML', { concurrency: true }, () => {
  test('returns a full HTML document with QUnit structural elements', (assert) => {
    const html = WebServer.buildErrorHTML({
      type: 'Module Resolution Error',
      formatted: 'Could not find module',
    });
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'starts with DOCTYPE');
    assert.includes(html, 'id="qunit-header"');
    assert.includes(html, 'id="qunit-banner"');
    assert.includes(html, 'id="qunit-userAgent"');
    assert.includes(html, 'id="qunit-tests"');
    assert.includes(html, 'id="qunit-testresult"');
  });

  test('places the error type in the userAgent bar', (assert) => {
    const html = WebServer.buildErrorHTML({ type: 'Syntax Error', formatted: 'details' });
    assert.includes(html, 'Syntax Error');
  });

  test('HTML-escapes angle brackets and ampersands in the formatted error', (assert) => {
    const html = WebServer.buildErrorHTML({
      type: 'Build Error',
      formatted: '<script>alert("xss")</script> & more',
    });
    assert.notIncludes(html, '<script>alert');
    assert.includes(html, '&lt;script&gt;');
    assert.includes(html, '&amp;');
  });

  test('includes WebSocket reconnect script guarded by location.port', (assert) => {
    const html = WebServer.buildErrorHTML({ type: 'Build Error', formatted: 'err' });
    assert.includes(html, 'location.port');
    assert.includes(html, 'WebSocket');
    assert.includes(html, "e.data === 'refresh'");
  });

  test('uses QUnit brand colors in the stylesheet', (assert) => {
    const html = WebServer.buildErrorHTML({ type: 'Build Error', formatted: 'err' });
    assert.includes(html, '#0D3349');
    assert.includes(html, '#EE5757');
    assert.includes(html, '#2B81AF');
  });
});

// ---------------------------------------------------------------------------
// buildNoTestsHTML
// ---------------------------------------------------------------------------

module('Setup | buildNoTestsHTML', { concurrency: true }, () => {
  test('returns a full HTML document with QUnit structural elements', (assert) => {
    const html = WebServer.buildNoTestsHTML(['test/fixtures/no-tests.ts']);
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'starts with DOCTYPE');
    assert.includes(html, 'id="qunit-header"');
    assert.includes(html, 'id="qunit-banner"');
    assert.includes(html, 'id="qunit-userAgent"');
    assert.includes(html, 'id="qunit-tests"');
    assert.includes(html, 'id="qunit-testresult"');
  });

  test('places "Warning: No Tests Registered" in the userAgent bar', (assert) => {
    const html = WebServer.buildNoTestsHTML([]);
    assert.includes(html, 'Warning: No Tests Registered');
  });

  test('includes each file path in the output', (assert) => {
    const html = WebServer.buildNoTestsHTML(['test/a.ts', 'test/b.ts']);
    assert.includes(html, 'test/a.ts');
    assert.includes(html, 'test/b.ts');
  });

  test('HTML-escapes angle brackets and ampersands in file paths', (assert) => {
    const html = WebServer.buildNoTestsHTML(['<evil>&path</evil>.ts']);
    assert.notIncludes(html, '<evil>');
    assert.includes(html, '&lt;evil&gt;');
    assert.includes(html, '&amp;');
  });

  test('uses amber banner color (not red) to signal a warning rather than an error', (assert) => {
    const html = WebServer.buildNoTestsHTML([]);
    assert.includes(html, '#F0AD4E');
    assert.notIncludes(html, '#EE5757');
  });

  test('includes WebSocket reconnect script guarded by location.port', (assert) => {
    const html = WebServer.buildNoTestsHTML([]);
    assert.includes(html, 'location.port');
    assert.includes(html, 'WebSocket');
    assert.includes(html, "e.data === 'refresh'");
  });
});

// ---------------------------------------------------------------------------
// buildTestBundle — fallbackPage lifecycle
// ---------------------------------------------------------------------------

module('Commands | buildTestBundle | fallbackPage lifecycle', { concurrency: true }, () => {
  test('sets a build-error fallback with type and formatted string when esbuild fails', async (assert) => {
    const tmpFile = `${CWD}/tmp/syntax-error-${randomUUID()}.ts`;
    await fs.mkdir(`${CWD}/tmp`, { recursive: true });
    await fs.writeFile(tmpFile, 'const x = {{{INVALID}}};');
    const config = makeConfig([tmpFile]);
    const cached = config.state.group.build;
    try {
      await assert.rejects(buildTestBundle(config), 'buildTestBundle rejects on build failure');
      const fallback = cached.fallbackPage;
      assert.equal(fallback?.kind, 'build-error', 'a build-error fallback is set');
      const error = fallback?.kind === 'build-error' ? fallback.error : null;
      assert.equal(typeof error?.type, 'string', 'type is a string');
      assert.ok((error?.type?.length ?? 0) > 0, 'type is non-empty');
      assert.equal(typeof error?.formatted, 'string', 'formatted is a string');
      assert.ok((error?.formatted?.length ?? 0) > 0, 'formatted is non-empty');
    } finally {
      await fs.rm(tmpFile, { force: true });
      await fs.rm(`${CWD}/${config.output}`, { force: true, recursive: true });
    }
  });

  test('clears the fallback to null after a successful build', async (assert) => {
    const config = makeConfig([`${CWD}/test/fixtures/passing-tests.ts`]);
    const cached = config.state.group.build;
    cached.fallbackPage = {
      kind: 'build-error',
      error: { type: 'Build Error', formatted: 'stale error from previous run' },
    };
    try {
      await buildTestBundle(config);
      assert.strictEqual(cached.fallbackPage, null, 'fallbackPage cleared on success');
    } finally {
      await fs.rm(`${CWD}/${config.output}`, { force: true, recursive: true });
    }
  });

  test('writes index.html with QUnit-styled error content on build failure (non-watch)', async (assert) => {
    const tmpFile = `${CWD}/tmp/syntax-error-${randomUUID()}.ts`;
    await fs.mkdir(`${CWD}/tmp`, { recursive: true });
    await fs.writeFile(tmpFile, 'this is } invalid { syntax !!!');
    const config = makeConfig([tmpFile]); // watch = false
    try {
      // Asserted, not merely tolerated. `.catch(() => {})` here accepted a *resolved*
      // build just as happily, so if buildTestBundle ever stopped rejecting on invalid
      // syntax this test would still pass while proving nothing.
      const built = await Result.attempt(() => buildTestBundle(config));
      assert.notOk(built.ok, 'an unparseable entry point rejects');
      const html = await fs.readFile(`${CWD}/${config.output}/index.html`, 'utf8');
      assert.ok(html.includes('<!DOCTYPE html>'), 'index.html is a full HTML document');
      assert.ok(html.includes('id="qunit-header"'), 'QUnit header element present');
      assert.ok(html.includes('id="qunit-banner"'), 'QUnit banner element present');
      assert.ok(html.includes('Build Error'), 'error category text present');
    } finally {
      await fs.rm(tmpFile, { force: true });
      await fs.rm(`${CWD}/${config.output}`, { force: true, recursive: true });
    }
  });

  test('writes index.html on build failure in watch mode too', async (assert) => {
    const tmpFile = `${CWD}/tmp/syntax-error-${randomUUID()}.ts`;
    await fs.mkdir(`${CWD}/tmp`, { recursive: true });
    await fs.writeFile(tmpFile, 'this is } invalid { syntax !!!');
    const config = makeConfig([tmpFile], true); // watch = true
    try {
      // Asserted, not merely tolerated. `.catch(() => {})` here accepted a *resolved*
      // build just as happily, so if buildTestBundle ever stopped rejecting on invalid
      // syntax this test would still pass while proving nothing.
      const built = await Result.attempt(() => buildTestBundle(config));
      assert.notOk(built.ok, 'an unparseable entry point rejects');
      const html = await fs.readFile(`${CWD}/${config.output}/index.html`, 'utf8');
      assert.ok(html.includes('<!DOCTYPE html>'), 'index.html written in watch mode too');
    } finally {
      await fs.rm(tmpFile, { force: true });
      await fs.rm(`${CWD}/${config.output}`, { force: true, recursive: true });
    }
  });
});

function makeConfig(testFiles: string[], watch = false): Config {
  return {
    output: `tmp/build-error-test-${randomUUID()}`,
    timeout: 30000,
    failFast: false,
    port: 1234,
    extensions: ['ts', 'js'],
    browser: 'chromium',
    projectRoot: CWD,
    inputs: [],
    htmlPaths: [],
    testFileLookupPaths: [],
    fsTree: Object.fromEntries(testFiles.map((f) => [f, null])),
    watch,
    state: RunState.create(),
  } as unknown as Config;
}
