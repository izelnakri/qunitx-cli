import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import '../helpers/custom-asserts.ts';
import { execute as shell, shellFails } from '../helpers/shell.ts';
import { outputDir } from '../helpers/temp-dir.ts';

const PROJECT_ROOT = process.cwd();
const FIXTURE_DIR = path.join(PROJECT_ROOT, 'test/fixtures/no-bundle-fixture');
const CLI_PATH = path.join(PROJECT_ROOT, 'cli.ts');
const HIDE_ESBUILD = pathToFileURL(path.join(PROJECT_ROOT, 'test/helpers/hide-esbuild.ts')).href;
const BROWSER = process.env.QUNITX_BROWSER || 'chromium';
// Deno's node:child_process rewrites a Node-style argv when it spawns deno, and drops `--import` on
// the way, so the deno lane names its own flag. A file URL, because node rejects `D:\…` there.
// A compiled release binary (QUNITX_BIN, the deno lane's) carries esbuild inside it: there is no
// install to take away, and the shell helper hands it only what follows `cli.ts`.
const withEsbuildHideable = process.env.QUNITX_BIN ? test.skip : test;
const WITHOUT_ESBUILD =
  'Deno' in globalThis ? `node run -A --preload=${HIDE_ESBUILD}` : `node --import ${HIDE_ESBUILD}`;

// The fixture is its own project: `package.json#qunitx.bundle: false`, a deno.json, an import-map
// file, `exports` and `imports` of its own — every layer the import map is built from, each
// exercised by one of the fixture's tests.
module('Inputs | --no-bundle', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('every import-map layer resolves, and a failure points at the original .ts line', async (assert, testMetadata) => {
    await using output = outputDir('no-bundle-layers');
    const result = await shellFails(
      `node ${CLI_PATH} tests --output=${path.join(PROJECT_ROOT, `${output}`)}`,
      { ...moduleMetadata, ...testMetadata, cwd: FIXTURE_DIR },
    );

    assert.exitCode(result, 1);
    assert.tapResult(result, { total: 4, failed: 1 });
    assert.regex(
      result.stdout,
      /ok \d+ no-bundle \| resolution \| package\.json#imports and an enum/,
    );
    assert.regex(result.stdout, /ok \d+ no-bundle \| resolution \| self-reference through exports/);
    assert.regex(
      result.stdout,
      /ok \d+ no-bundle \| resolution \| deno\.json imports and a \.js specifier/,
    );
    // WebKit runs strict code with proper tail calls, so the frames above the test callback are
    // gone and QUnit's fixed offset into the stack lands on its own `run` — bundled runs too.
    if (BROWSER !== 'webkit') {
      assert.regex(result.stdout, /at: tests\/native-test\.ts:\d+:12/);
      assert.regex(
        result.stdout,
        /source: assert\.equal\(apply\(Operation\.Add, 1, 1\), 3, 'deliberately wrong'\);/,
      );
    }
  });

  test('a file that fails to load is one failing test with the reason; its siblings still run', async (assert, testMetadata) => {
    await using output = outputDir('no-bundle-broken');
    const result = await shellFails(
      `node ${CLI_PATH} broken --output=${path.join(PROJECT_ROOT, `${output}`)}`,
      { ...moduleMetadata, ...testMetadata, cwd: FIXTURE_DIR },
    );

    assert.exitCode(result, 1);
    assert.tapResult(result, { total: 3, failed: 2 });
    assert.regex(result.stdout, /ok \d+ broken \| a sibling of broken files \| still runs/);
    assert.regex(
      result.stdout,
      /cannot find lib\/strings — imports need their file extension in a --no-bundle run; did you mean strings\.ts\? \(imported by broken\/a-missing-file-test\.ts\)/,
    );
    // Each engine words the resolution error itself, quotes included: "left-pad", “left-pad”, 'left-pad'.
    assert.regex(
      result.stdout,
      /["“']left-pad["”'][^\n]*\n\s*A bare import must be in the import map/,
    );
    // Just this file's TAP block: the groups run concurrently, so the other broken file's block
    // can come before or after it.
    const unmappedBlock =
      /b-unmapped-package-test\.ts \| loads without errors[\s\S]*?\n {2}\.\.\./.exec(
        result.stdout,
      )?.[0];
    assert.true(Boolean(unmappedBlock), 'the unmapped-package failure has its own block');
    assert.notIncludes(
      unmappedBlock ?? '',
      'lib/strings',
      "one file's load error is not reported against another",
    );
  });

  test('coverage is attributed to the original files, module by module', async (assert, testMetadata) => {
    await using output = outputDir('no-bundle-coverage');
    const result = await shell(
      `node cli.ts test/fixtures/coverage/calculator-test.ts --no-bundle --coverage=lcov --output=${output}`,
      { ...moduleMetadata, ...testMetadata },
    );
    if (BROWSER !== 'chromium') return assert.includes(result, 'requires the chromium browser');

    const lcov = await fs.readFile(`${output}/coverage/lcov.info`, 'utf8');

    assert.true(lcov.includes('SF:test/fixtures/coverage/calculator.ts'), lcov);
    assert.true(lcov.includes('DA:5,1'), 'add() ran');
    assert.true(lcov.includes('DA:9,0'), 'subtract() did not');
    assert.false(lcov.includes('DA:1,'), 'a comment line is not coverable');
  });
});

module('Inputs | without esbuild installed', { concurrency: true }, (_hooks, moduleMetadata) => {
  withEsbuildHideable(
    'a run falls back to --no-bundle on its own, and says so once',
    async (assert, testMetadata) => {
      await using output = outputDir('no-esbuild-fallback');
      const result = await shell(
        `${WITHOUT_ESBUILD} cli.ts test/fixtures/passing-tests.ts --output=${output}`,
        { ...moduleMetadata, ...testMetadata },
      );

      const notice = 'esbuild is not installed — loading the tests natively through an import map';
      assert.equal(result.stdout.split(notice).length - 1, 1, 'the notice, exactly once');
      assert.tapResult(result, { total: 3 });
    },
  );

  withEsbuildHideable(
    '--bundle without esbuild exits 1 with the fix, before starting a browser',
    async (assert, testMetadata) => {
      const result = await shellFails(
        `${WITHOUT_ESBUILD} cli.ts test/fixtures/passing-tests.ts --bundle`,
        { ...moduleMetadata, ...testMetadata },
      );

      assert.exitCode(result, 1);
      assert.true(
        result.stderr.includes('needs esbuild, which is not installed') &&
          result.stderr.includes('--no-bundle'),
        result.stderr,
      );
    },
  );
});
