import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { module, test } from 'qunitx';
import { benchFiles, checkSettings, parseArgs } from '../../lib/commands/bench.ts';
import * as Failure from '../../lib/result/failure.ts';
import * as QUnitX from '../../lib/api/index.ts';
import { execute, shellFails } from '../helpers/shell.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import '../helpers/custom-asserts.ts';

// `qunitx bench`: Deno.bench files measured in the lane's browser. Benches here are measured for a
// few milliseconds each — what is checked is the shape of what comes back, not the numbers.
const CLI = `node ${path.resolve('cli.ts')}`;
const BROWSER = process.env.QUNITX_BROWSER || 'chromium';
const FAST = '--time=20 --warmup=5';

// A file that uses the DOM (it runs in a browser, not in Node), both spellings of bench, a group
// with a baseline, an explicit timer, a failure and an ignored bench.
const DOM_BENCH = `
const list = document.createElement('ul');
Deno.bench('render rows', () => {
  list.innerHTML = '<li>a</li><li>b</li><li>c</li>';
  return list.childElementCount;
});
bench({ name: 'sort', group: 'arrays', baseline: true, fn: () => [3, 1, 2].sort() });
bench({ name: 'toSorted', group: 'arrays', fn: () => [3, 1, 2].toSorted() });
Deno.bench('part', (b) => {
  const until = performance.now() + 0.05;
  while (performance.now() < until);
  b.start();
  const end = performance.now() + 0.05;
  while (performance.now() < end);
  b.end();
});
Deno.bench({ name: 'skipped', ignore: true, fn() {} });
`;

module('Commands | bench | arguments', { concurrency: true }, () => {
  test("flags become settings: deno bench's names, times with units, QUNITX_BROWSER as the default", (assert) => {
    const parsed = parseArgs(
      [
        'benches',
        'a.bench.ts',
        '--json',
        '-t',
        '/^render/',
        '--min-delta=2us',
        '--threshold=15%',
        '--ignore=a,b',
        '--profile',
        '--retries',
        '0',
        '--no-run',
        '--permit-no-files',
        '-w',
      ],
      { QUNITX_BROWSER: 'chromium' },
    );
    const firefox = parseArgs(['--browser=firefox', '--reporter=markdown'], {
      QUNITX_BROWSER: 'webkit',
    });

    assert.false(Failure.is(parsed));
    assert.deepEqual(!Failure.is(parsed) && parsed.inputs, ['benches', 'a.bench.ts']);
    assert.deepEqual(!Failure.is(parsed) && parsed.settings, {
      format: 'json',
      filter: '/^render/',
      minDelta: 2000,
      threshold: 15,
      ignore: ['a', 'b'],
      profile: 'tmp/bench-profiles',
      retries: 0,
      noRun: true,
      permitNoFiles: true,
      watch: true,
      browser: 'chromium',
    });
    assert.deepEqual(!Failure.is(firefox) && firefox.settings, {
      browser: 'firefox',
      format: 'markdown',
    });
  });

  test('a flag that will not do is named with what it expected', (assert) => {
    const messages = [
      ['--reporter=tap'],
      ['--threshold=x'],
      ['--min-delta=fast'],
      ['--cpu-throttle=4', '--browser=webkit'],
      ['--frobnicate'],
      ['--save'],
    ].map((argv) => {
      const parsed = parseArgs(argv, {});
      return Failure.is(parsed) ? parsed.message : null;
    });

    assert.deepEqual(messages, [
      'qunitx bench format: expected pretty, json, markdown, csv, got "tap"',
      'qunitx bench threshold: expected a percentage, got "x"',
      'qunitx bench minDelta: expected a time, such as 500ns, 2µs or 1ms, got "fast"',
      'qunitx bench cpuThrottle: needs chromium: webkit has no DevTools protocol to ask',
      'qunitx bench --frobnicate: unknown flag (see qunitx bench --help)',
      'qunitx bench --save: needs a value',
    ]);
    assert.includes(
      checkSettings({ colour: true })!.message,
      'qunitx bench colour: is not a setting',
    );
  });

  test("files are deno bench's names, at any depth, minus node_modules, ignored paths and globs", async (assert) => {
    await using dir = await tempDir('bench-files');
    const files = [
      'bench.ts',
      'a_bench.js',
      'b.bench.mts',
      'deep/c.bench.tsx',
      'deep/d.bench.mjs',
      'deep/e.bench.jsx',
      'not-a-bench.ts',
      'benchmark.ts',
      'node_modules/pkg/x.bench.ts',
      'skip/f.bench.ts',
      'g.bench.ts',
    ];
    for (const file of files) {
      await fs.mkdir(path.dirname(path.join(dir.path, file)), { recursive: true });
      await fs.writeFile(path.join(dir.path, file), '');
    }
    const found = await benchFiles([], dir.path, [
      path.join(dir.path, 'skip'),
      path.join(dir.path, 'g.*.ts'),
    ]);
    const globbed = await benchFiles(['deep/*.bench.m*'], dir.path, []);

    assert.deepEqual(
      found.map((file) => path.relative(dir.path, file).split(path.sep).join('/')),
      [
        'a_bench.js',
        'b.bench.mts',
        'bench.ts',
        'deep/c.bench.tsx',
        'deep/d.bench.mjs',
        'deep/e.bench.jsx',
      ],
    );
    assert.deepEqual(
      globbed.map((file) => path.basename(file)),
      ['d.bench.mjs'],
    );
  });
});

module('Commands | bench | running', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('a file is measured in the browser and printed as deno bench prints it; a failure fails the run', async (assert, testMetadata) => {
    await using dir = await tempDir('bench-pretty');
    await fs.writeFile(path.join(dir.path, 'dom.bench.ts'), DOM_BENCH);
    await fs.writeFile(
      path.join(dir.path, 'fails.bench.ts'),
      "Deno.bench('throws', () => { throw new TypeError('boom'); });\nDeno.bench('fine', () => { console.log('said by a bench'); });\n",
    );
    const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
    const [good, bad] = await Promise.all([
      execute(`${CLI} bench dom.bench.ts ${FAST} --browser=${BROWSER}`, metadata),
      shellFails(`${CLI} bench fails.bench.ts ${FAST} --browser=${BROWSER}`, metadata),
    ]);

    assert.includes(good.stdout, '    CPU | ');
    assert.includes(
      good.stdout,
      `Runtime | ${{ chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' }[BROWSER]}/`,
    );
    assert.includes(
      good.stdout,
      '| benchmark   | time/iter (avg) |        iter/s |      (min … max)      |',
    );
    assert.true(
      /\| render rows \|\s+[\d.]+ [pnµm]?s \|/.test(good.stdout),
      'measured in a page with a DOM',
    );
    assert.includes(good.stdout, 'group arrays');
    assert.true(
      /summary\n {2}sort\n {5}[\d.]+x (faster|slower) than toSorted/.test(good.stdout),
      'the group summed up against its baseline',
    );
    assert.notIncludes(good.stdout, 'skipped');
    assert.equal(good.code, 0);
    assert.includes(bad.stdout, 'throws      error: TypeError: boom');
    assert.includes(
      bad.stdout,
      'fails.bench.ts:1:',
      'its stack points at the file it was written in',
    );
    assert.includes(
      bad.stderr,
      'said by a bench',
      "a bench's console goes to stderr, out of the report's way",
    );
    assert.includes(bad.stderr, 'error: Bench failed');
  });

  test("--json is deno bench --json's report; --save writes it, --compare fails a run that regressed", async (assert, testMetadata) => {
    await using dir = await tempDir('bench-compare');
    await fs.writeFile(path.join(dir.path, 'dom.bench.ts'), DOM_BENCH);
    const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
    const saved = await execute(
      `${CLI} bench ${FAST} --browser=${BROWSER} --json --save=tmp/base.json`,
      metadata,
    );
    const report = JSON.parse(saved.stdout);
    // The baseline made a thousand times faster, so this run regressed, and a thousand times
    // slower, so it cannot have: either way, however loaded the machine that measured both.
    const scaled = (factor: number) => {
      const copy = structuredClone(report);
      for (const bench of copy.benches) bench.results[0].ok.avg *= factor;
      return JSON.stringify(copy);
    };
    await fs.writeFile(path.join(dir.path, 'fast.json'), scaled(0.001));
    await fs.writeFile(path.join(dir.path, 'slow.json'), scaled(1000));
    const [same, regressed] = await Promise.all([
      execute(
        `${CLI} bench ${FAST} --browser=${BROWSER} --compare=slow.json --reporter=csv`,
        metadata,
      ),
      shellFails(
        `${CLI} bench ${FAST} --browser=${BROWSER} --compare=fast.json --min-delta=0 --retries=1`,
        metadata,
      ),
    ]);

    assert.deepEqual(Object.keys(report), ['version', 'runtime', 'cpu', 'benches']);
    assert.deepEqual(
      report.benches.map((bench: { name: string; group: string | null }) => [
        bench.name,
        bench.group,
      ]),
      [
        ['render rows', null],
        ['part', null],
        ['sort', 'arrays'],
        ['toSorted', 'arrays'],
      ],
    );
    // The bench file, however the platform spells its path: macOS's temp folder is a link to
    // /private/var, and Windows's has an 8.3 short name (RUNNER~1) the command keeps.
    assert.true(report.benches[0].origin.startsWith('file:///'));
    assert.equal(
      await fs.realpath(fileURLToPath(report.benches[0].origin)),
      await fs.realpath(path.join(dir.path, 'dom.bench.ts')),
    );
    assert.true(
      report.benches[1].results[0].ok.usedExplicitTimers,
      'part timed by start() and end()',
    );
    assert.equal(
      report.benches[0].results[0].ok.highPrecision,
      true,
      'a cross-origin-isolated page: a fine clock',
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(dir.path, 'tmp', 'base.json'), 'utf8')),
      report,
    );
    assert.includes(same.stdout, 'base_avg_ns,change_percent,regressed');
    assert.includes(same.stderr, '# No regressions against slow.json: 4 benches compared');
    assert.includes(regressed.stderr, '# 4 regressions against fast.json:');
    assert.includes(regressed.stdout, 'vs base');
  });

  test("`only` runs those alone and fails the run; no files is an error unless permitted; --no-run checks the build, and says why a file on node's modules cannot run", async (assert, testMetadata) => {
    await using dir = await tempDir('bench-only');
    await fs.mkdir(path.join(dir.path, 'empty'));
    await fs.writeFile(
      path.join(dir.path, 'only.bench.ts'),
      "Deno.bench({ name: 'focused', only: true, fn() {} });\nDeno.bench('other', () => {});\n",
    );
    await fs.writeFile(path.join(dir.path, 'broken.bench.ts'), 'Deno.bench("x", () => {\n');
    await fs.writeFile(
      path.join(dir.path, 'node.bench.ts'),
      "import fs from 'node:fs';\nimport path from 'path';\nDeno.bench('reads', () => fs.existsSync(path.sep));\n",
    );
    const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
    const [only, none, permitted, check, broken, node] = await Promise.all([
      shellFails(`${CLI} bench only.bench.ts ${FAST} --browser=${BROWSER}`, metadata),
      shellFails(`${CLI} bench empty`, metadata),
      execute(`${CLI} bench empty --permit-no-files`, metadata),
      execute(`${CLI} bench only.bench.ts --no-run`, metadata),
      shellFails(`${CLI} bench broken.bench.ts --no-run`, metadata),
      shellFails(`${CLI} bench node.bench.ts --no-run`, metadata),
    ]);

    assert.includes(only.stdout, 'focused');
    assert.notIncludes(only.stdout, 'other');
    assert.includes(only.stderr, 'error: Bench failed because the "only" option was used');
    assert.includes(none.stderr, 'No bench modules found in empty');
    assert.equal(permitted.code, 0);
    assert.includes(check.stdout, 'Check only.bench.ts');
    assert.includes(broken.stderr, 'broken.bench.ts would not build');
    // One explanation for every import of node's modules, not a line per import.
    assert.includes(
      node.stderr,
      "node.bench.ts would not build: it imports node's own modules (node:fs, path, first in node.bench.ts), which a browser does not have.\nRun it with `deno bench`, or leave it out: --ignore=node.bench.ts",
    );
    assert.notIncludes(node.stderr, 'Could not resolve');
  });

  test('package.json#qunitx.bench sets inputs and settings; --profile writes a CPU profile a bench (chromium)', async (assert, testMetadata) => {
    await using dir = await tempDir('bench-config');
    await fs.mkdir(path.join(dir.path, 'benches'));
    await fs.writeFile(
      path.join(dir.path, 'benches', 'x.bench.ts'),
      "Deno.bench('loop', () => { let s = 0; for (let i = 0; i < 100; i++) s += i; return s; });\n",
    );
    await fs.writeFile(
      path.join(dir.path, 'unrelated.bench.ts'),
      "Deno.bench('unrelated', () => {});\n",
    );
    await fs.writeFile(
      path.join(dir.path, 'package.json'),
      JSON.stringify({
        name: 'x',
        qunitx: { bench: { inputs: ['benches'], time: 20, warmup: 5, format: 'csv' } },
      }),
    );
    const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
    const configured = await execute(`${CLI} bench --browser=${BROWSER}`, metadata);

    assert.includes(configured.stdout, 'file,group,name');
    assert.includes(configured.stdout, ',loop,');
    assert.notIncludes(configured.stdout, 'unrelated', 'only the inputs package.json names');
    if (BROWSER !== 'chromium') return;
    await execute(`${CLI} bench --profile=profiles --cpu-throttle=2 --reporter=json`, metadata);
    const profile = JSON.parse(
      await fs.readFile(path.join(dir.path, 'profiles', 'x.bench--loop.cpuprofile'), 'utf8'),
    );

    assert.true(
      Array.isArray(profile.nodes) && profile.nodes.length > 0,
      'a profile Chrome DevTools opens',
    );
  });
});

module('API | bench', { concurrency: true }, () => {
  test('Bench.run() resolves with the report and the exit code; no files rejects, naming them', async (assert) => {
    await using dir = await tempDir('bench-api');
    await fs.writeFile(path.join(dir.path, 'a.bench.ts'), "Deno.bench('noop', () => {});\n");
    const permit = await acquireBrowser();
    try {
      const result = await QUnitX.Bench.run('a.bench.ts', {
        cwd: dir.path,
        browser: BROWSER as 'chromium',
        time: 20,
        warmup: 5,
        console: QUnitX.silentConsole,
      });
      const missing = await QUnitX.Bench.run('nowhere', { cwd: dir.path }).result();

      assert.deepEqual(
        [result.ok, result.exitCode, result.report.benches.map((bench) => bench.name)],
        [true, 0, ['noop']],
      );
      assert.true(QUnitX.Failure.is(missing));
      assert.includes((missing as Error).message, 'No bench modules found in nowhere');
    } finally {
      permit.release();
    }
  });
});
