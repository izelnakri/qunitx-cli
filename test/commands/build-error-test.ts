import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import '../helpers/custom-asserts.ts';
import {
  buildTestBundle,
  deriveBuildErrorType,
  formatBuildErrors,
} from '../../lib/commands/run/tests-in-browser.ts';
import { buildErrorHTML, buildNoTestsHTML } from '../../lib/setup/web-server.ts';
import type { Config, CachedContent } from '../../lib/types.ts';

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
    const html = buildErrorHTML({
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
    const html = buildErrorHTML({ type: 'Syntax Error', formatted: 'details' });
    assert.includes(html, 'Syntax Error');
  });

  test('HTML-escapes angle brackets and ampersands in the formatted error', (assert) => {
    const html = buildErrorHTML({
      type: 'Build Error',
      formatted: '<script>alert("xss")</script> & more',
    });
    assert.notIncludes(html, '<script>alert');
    assert.includes(html, '&lt;script&gt;');
    assert.includes(html, '&amp;');
  });

  test('includes WebSocket reconnect script guarded by location.port', (assert) => {
    const html = buildErrorHTML({ type: 'Build Error', formatted: 'err' });
    assert.includes(html, 'location.port');
    assert.includes(html, 'WebSocket');
    assert.includes(html, "e.data === 'refresh'");
  });

  test('uses QUnit brand colors in the stylesheet', (assert) => {
    const html = buildErrorHTML({ type: 'Build Error', formatted: 'err' });
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
    const html = buildNoTestsHTML(['test/fixtures/no-tests.ts']);
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'starts with DOCTYPE');
    assert.includes(html, 'id="qunit-header"');
    assert.includes(html, 'id="qunit-banner"');
    assert.includes(html, 'id="qunit-userAgent"');
    assert.includes(html, 'id="qunit-tests"');
    assert.includes(html, 'id="qunit-testresult"');
  });

  test('places "Warning: No Tests Registered" in the userAgent bar', (assert) => {
    const html = buildNoTestsHTML([]);
    assert.includes(html, 'Warning: No Tests Registered');
  });

  test('includes each file path in the output', (assert) => {
    const html = buildNoTestsHTML(['test/a.ts', 'test/b.ts']);
    assert.includes(html, 'test/a.ts');
    assert.includes(html, 'test/b.ts');
  });

  test('HTML-escapes angle brackets and ampersands in file paths', (assert) => {
    const html = buildNoTestsHTML(['<evil>&path</evil>.ts']);
    assert.notIncludes(html, '<evil>');
    assert.includes(html, '&lt;evil&gt;');
    assert.includes(html, '&amp;');
  });

  test('uses amber banner color (not red) to signal a warning rather than an error', (assert) => {
    const html = buildNoTestsHTML([]);
    assert.includes(html, '#F0AD4E');
    assert.notIncludes(html, '#EE5757');
  });

  test('includes WebSocket reconnect script guarded by location.port', (assert) => {
    const html = buildNoTestsHTML([]);
    assert.includes(html, 'location.port');
    assert.includes(html, 'WebSocket');
    assert.includes(html, "e.data === 'refresh'");
  });
});

// ---------------------------------------------------------------------------
// buildTestBundle — _buildError lifecycle
// ---------------------------------------------------------------------------

module('Commands | buildTestBundle | _buildError lifecycle', { concurrency: true }, () => {
  test('sets _buildError with type and formatted string when esbuild fails', async (assert) => {
    const tmpFile = `${CWD}/tmp/syntax-error-${randomUUID()}.ts`;
    await fs.mkdir(`${CWD}/tmp`, { recursive: true });
    await fs.writeFile(tmpFile, 'const x = {{{INVALID}}};');
    const config = makeConfig([tmpFile]);
    const cached = makeCachedContent();
    try {
      await assert.rejects(
        buildTestBundle(config, cached),
        'buildTestBundle rejects on build failure',
      );
      assert.ok(cached._buildError, '_buildError is set');
      assert.equal(typeof cached._buildError?.type, 'string', 'type is a string');
      assert.ok((cached._buildError?.type?.length ?? 0) > 0, 'type is non-empty');
      assert.equal(typeof cached._buildError?.formatted, 'string', 'formatted is a string');
      assert.ok((cached._buildError?.formatted?.length ?? 0) > 0, 'formatted is non-empty');
    } finally {
      await fs.rm(tmpFile, { force: true });
      await fs.rm(`${CWD}/${config.output}`, { force: true, recursive: true });
    }
  });

  test('clears _buildError to null after a successful build', async (assert) => {
    const config = makeConfig([`${CWD}/test/helpers/passing-tests.ts`]);
    const cached = makeCachedContent();
    cached._buildError = { type: 'Build Error', formatted: 'stale error from previous run' };
    try {
      await buildTestBundle(config, cached);
      assert.strictEqual(cached._buildError, null, '_buildError cleared on success');
    } finally {
      await fs.rm(`${CWD}/${config.output}`, { force: true, recursive: true });
    }
  });

  test('writes index.html with QUnit-styled error content on build failure (non-watch)', async (assert) => {
    const tmpFile = `${CWD}/tmp/syntax-error-${randomUUID()}.ts`;
    await fs.mkdir(`${CWD}/tmp`, { recursive: true });
    await fs.writeFile(tmpFile, 'this is } invalid { syntax !!!');
    const config = makeConfig([tmpFile]); // watch = false
    const cached = makeCachedContent();
    try {
      await buildTestBundle(config, cached).catch(() => {});
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
    const cached = makeCachedContent();
    try {
      await buildTestBundle(config, cached).catch(() => {});
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
    COUNTER: {
      testCount: 0,
      failCount: 0,
      skipCount: 0,
      todoCount: 0,
      passCount: 0,
      errorCount: 0,
    },
    lastFailedTestFiles: null,
    lastRanTestFiles: null,
    _testRunDone: null,
    _resetTestTimeout: null,
    _onWsOpen: null,
    _onTestsJsServed: null,
  } as unknown as Config;
}

function makeCachedContent(): CachedContent {
  return {
    allTestCode: null,
    assets: new Set(),
    htmlPathsToRunTests: ['/'],
    mainHTML: { filePath: null, html: null },
    staticHTMLs: {},
    dynamicContentHTMLs: {},
  };
}
