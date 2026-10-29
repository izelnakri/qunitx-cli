import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { shellSettles, shellWatch, spawnCapture } from '../helpers/shell.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';
import { decodeGif } from '../helpers/gif-decode.ts';
import { rmRetry } from '../helpers/rm-retry.ts';
import * as Client from '../../lib/commands/daemon/client.ts';
import { parsePdf } from '../helpers/pdf-parse.ts';
import '../helpers/custom-asserts.ts';

const CWD = process.cwd();

// A project of its own per test, under tmp/ so `qunitx` resolves through the symlinked
// node_modules, with its own snapshots/ — tests in this file run concurrently.
async function project(
  files: Record<string, string>,
  qunitx: Record<string, unknown> = {},
): Promise<{
  cwd: string;
  write(file: string, content: string): void;
  [Symbol.asyncDispose](): Promise<void>;
}> {
  const cwd = path.join(CWD, 'tmp', `snapshots-${randomUUID()}`);
  await fs.mkdir(path.join(cwd, 'test'), { recursive: true });
  await fs.mkdir(path.join(cwd, 'src'), { recursive: true });
  await fs.symlink(path.join(CWD, 'node_modules'), path.join(cwd, 'node_modules'));
  await fs.writeFile(
    path.join(cwd, 'package.json'),
    JSON.stringify({ name: path.basename(cwd), type: 'module', qunitx }),
  );
  const write = (file: string, content: string) => writeFileSync(path.join(cwd, file), content);
  for (const [file, content] of Object.entries(files)) write(file, content);
  return {
    cwd,
    write,
    [Symbol.asyncDispose]: () => rmRetry(cwd),
  };
}

const run = (cwd: string, args = '') => shellSettles(`node ${CWD}/cli.ts test/ ${args}`, { cwd });
const pngSize = (file: string) => {
  const bytes = readFileSync(file);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};
const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

const BOX_TEST = `import { module, test } from 'qunitx';
import { COLOR } from '../src/state.ts';

module('Box', () => {
  test('is drawn', async (assert) => {
    document.body.innerHTML = '<div id="box" style="width:120px;height:60px;background:' + COLOR + '"></div>';
    const shot = await globalThis.qunitxSnapshot!('box', { selector: '#box' });
    assert.ok(shot.path.endsWith('box.png'), shot.status);
  });
});
`;

module('Commands | snapshots inside tests', { concurrency: true }, () => {
  test('a snapshot goes new, unchanged, changed (failing the run) and, accepted, updated', async (assert) => {
    await using app = await project({
      'test/box-test.ts': BOX_TEST,
      'src/state.ts': `export const COLOR = 'rgb(0,0,255)';`,
    });
    const baseline = path.join(app.cwd, 'snapshots', 'box.png');
    const review = ['box.diff.png', 'box.new.png'].map((file) =>
      path.join(app.cwd, 'snapshots', file),
    );

    const first = await run(app.cwd);
    const second = await run(app.cwd);
    app.write('src/state.ts', `export const COLOR = 'rgb(255,0,0)';`);
    const changed = await run(app.cwd);
    const reviewWritten = await Promise.all(review.map(exists));
    const accepted = await run(app.cwd, '--update-snapshots');
    const reviewAfter = await Promise.all(review.map(exists));
    const after = await run(app.cwd);

    assert.exitCode(first, 0);
    assert.deepEqual(pngSize(baseline), [120, 60], 'the element, not the page');
    assert.exitCode(second, 0);
    assert.exitCode(changed, 1, 'a changed snapshot fails the run');
    assert.includes(
      changed.stdout,
      `# snapshot "box" (Box > is drawn) changed: 7,200 pixels (100.00%) → ${path.join('snapshots', 'box.diff.png')}, ${path.join('snapshots', 'box.new.png')}`,
    );
    assert.includes(changed.stdout, 'run again with --update-snapshots to accept');
    assert.deepEqual(reviewWritten, [true, true], 'a diff and the new screenshot to review');
    assert.exitCode(accepted, 0, 'accepting is a green run');
    assert.deepEqual(reviewAfter, [false, false], 'and clears the review files');
    assert.exitCode(after, 0, 'the accepted one is the baseline now');
  });

  test('threshold, maxDiff and masks per snapshot and per run; fullPage takes the whole page', async (assert) => {
    await using app = await project({
      'src/state.ts': `export const SHADE = 255; export const CLOCK = '12:00';`,
      'test/tolerance-test.ts': `import { module, test } from 'qunitx';
import { SHADE, CLOCK } from '../src/state.ts';

module('Tolerance', () => {
  test('shots', async (assert) => {
    document.body.style.margin = '0';
    document.body.innerHTML = '<div style="height:2400px"><div id="box" style="position:absolute;left:0;top:0;width:100px;height:60px;background:rgb(0,0,' + SHADE + ')"></div>' +
      '<div id="clock" style="position:absolute;left:120px;top:0;font:20px monospace">' + CLOCK + '</div></div>';
    const take = globalThis.qunitxSnapshot!;
    await take('lenient', { threshold: 0.5, mask: ['#clock'] });
    await take('strict', { threshold: 0, mask: ['#clock'] });
    await take('few', { threshold: 0.5, maxDiff: 2000 });
    await take('run-mask', { threshold: 0.5 });
    await take('page', { fullPage: true });
    assert.ok(true);
  });
});
`,
    });
    const flags = '--snapshot-mask=#clock';
    const first = await run(app.cwd, flags);
    app.write('src/state.ts', `export const SHADE = 235; export const CLOCK = '12:01';`);
    const second = await run(app.cwd, flags);
    const changedNames = [
      ...second.stdout.matchAll(/# snapshot "([^"]+)" \(Tolerance > shots\) changed/g),
    ].map((match) => match[1]);

    assert.exitCode(first, 0);
    assert.true(pngSize(path.join(app.cwd, 'snapshots', 'page.png'))[1] >= 2400, 'the whole page');
    assert.exitCode(second, 1);
    assert.deepEqual(
      changedNames,
      ['strict'],
      'only the strict one counts a slight shade as a change',
    );
  });

  test('a name taken twice in one run fails, naming both tests, across files', async (assert) => {
    const file = (module: string, name: string) => `import { module, test } from 'qunitx';
module('${module}', () => {
  test('${name}', async (assert) => {
    document.body.innerHTML = '<p>${module}</p>';
    await globalThis.qunitxSnapshot!('same');
    assert.ok(true);
  });
});
`;
    await using app = await project({
      'test/a-test.ts': file('A', 'one'),
      'test/b-test.ts': file('B', 'two'),
    });
    const result = await run(app.cwd);

    assert.exitCode(result, 1);
    assert.includes(result.stdout, 'qunitxSnapshot("same") was already taken in this run, by ');
    assert.true(
      /by (A > one|B > two); snapshot names have to be unique \(taken again by (B > two|A > one)\)/.test(
        result.stdout,
      ),
      'both tests named',
    );
  });

  test('report and comment are written into the snapshot dir, which is configurable', async (assert) => {
    await using app = await project(
      {
        'test/box-test.ts': BOX_TEST,
        'src/state.ts': `export const COLOR = 'rgb(0,0,255)';`,
      },
      { snapshots: { dir: 'visual', report: true } },
    );
    const result = await run(
      app.cwd,
      '--snapshot-pr-comment --snapshot-images-url=https://example.com/visual/ --snapshot-report-url=https://example.com/run/1',
    );
    const comment = await fs.readFile(path.join(app.cwd, 'visual', 'comment.md'), 'utf8');

    assert.exitCode(result, 0);
    assert.true(
      await exists(path.join(app.cwd, 'visual', 'box.png')),
      'package.json moved the dir',
    );
    assert.includes(result.stdout, `# snapshot report: ${path.join('visual', 'report.html')}`);
    assert.includes(await fs.readFile(path.join(app.cwd, 'visual', 'report.html'), 'utf8'), 'box');
    assert.includes(comment, '<!-- qunitx-visual-diff -->');
    assert.includes(comment, '1 new snapshot');
    assert.includes(comment, 'https://example.com/run/1');
  });

  test('the report prints to report.pdf with snapshots.pdf; a setting raster cannot do stops the run', async (assert) => {
    await using app = await project(
      {
        'test/box-test.ts': BOX_TEST,
        'src/state.ts': `export const COLOR = 'rgb(0,0,255)';`,
      },
      { snapshots: { report: ['html', 'pdf'], pdf: { paper: 'A5', mode: 'raster' } } },
    );
    await using refused = await project(
      { 'test/box-test.ts': BOX_TEST, 'src/state.ts': `export const COLOR = 'rgb(0,0,255)';` },
      { snapshots: { report: 'pdf', pdf: { mode: 'raster', footer: '<span></span>' } } },
    );
    const [result, stopped] = await Promise.all([run(app.cwd), run(refused.cwd)]);
    const pdf = parsePdf(await fs.readFile(path.join(app.cwd, 'snapshots', 'report.pdf')));

    assert.exitCode(result, 0);
    assert.includes(result.stdout, `# snapshot report: ${path.join('snapshots', 'report.pdf')}`);
    assert.includes(result.stdout, `# snapshot report: ${path.join('snapshots', 'report.html')}`);
    assert.true(
      pdf.pages.length >= 1 &&
        pdf.pages.every(
          ([, , width, height]) => Math.abs(width - 419.5) < 1 && Math.abs(height - 595.3) < 1,
        ),
      `A5, from snapshots.pdf (${pdf.pages})`,
    );
    assert.deepEqual([pdf.fonts, pdf.jpegs > 0], [false, true], 'raster, as asked');
    assert.notEqual(stopped.code, 0);
    assert.includes(
      stopped.stderr + stopped.stdout,
      'snapshots.pdf: footer needs vector mode; mode is raster',
    );
  });

  test('a step recording is a GIF of what was drawn, and one never stopped is reported', async (assert) => {
    await using app = await project({
      'test/step-test.ts': `import { module, test } from 'qunitx';

module('Step', () => {
  test('recorded', async (assert) => {
    // Drawn beside QUnit's own markup, not over it: the next test needs that.
    document.body.insertAdjacentHTML('afterbegin', '<div id="box" style="width:120px;height:60px;background:blue"></div>');
    await globalThis.qunitxRecording!.start('flow/colors');
    for (const color of ['red', 'green', 'orange']) {
      document.getElementById('box')!.style.background = color;
      await globalThis.qunitxRecordFrame!();
    }
    const file = await globalThis.qunitxRecording!.stop();
    assert.true(file.frames >= 4, 'frames: ' + file.frames);
    await assert.rejects(globalThis.qunitxRecording!.stop(), /nothing is recording/);
  });
  test('left running', async (assert) => {
    await globalThis.qunitxRecording!.start('forgotten');
    assert.ok(true);
  });
});
`,
    });
    const result = await run(app.cwd);
    const gif = decodeGif(await fs.readFile(path.join(app.cwd, 'snapshots', 'flow', 'colors.gif')));
    const colors = gif.frames.map((frame) =>
      Array.from(frame.rgba.subarray(4 * 10 * gif.width + 40, 4 * 10 * gif.width + 43)),
    );

    assert.exitCode(result, 0);
    assert.true(colors.length >= 4, `one frame per step (${colors.length})`);
    assert.deepEqual(colors[0], [0, 0, 255], 'opening on the page as the recording started');
    assert.includes(
      result.stdout,
      `qunitxRecording: ${path.join('snapshots', 'forgotten.gif')} was started but never stopped`,
    );
  });

  test('a bad name or option rejects in the test; a bad flag or setting stops the run', async (assert) => {
    await using app = await project({
      'test/bad-test.ts': `import { module, test } from 'qunitx';

module('Bad', () => {
  test('options', async (assert) => {
    const take = globalThis.qunitxSnapshot!;
    await assert.rejects(take('x', { treshold: 1 } as never), /qunitxSnapshot\\("x"\\): treshold is not an option/);
    await assert.rejects(take('x', { threshold: 2 }), /threshold: expected a fraction from 0 to 1, got 2/);
    await assert.rejects(take('../out'), /not a usable snapshot name/);
    await assert.rejects(take('x', { selector: '#nowhere' }), /nowhere|Timeout/);
  });
});
`,
    });
    await using misconfigured = await project(
      {
        'test/bad-test.ts': `import { test } from 'qunitx'; test('t', (assert) => assert.ok(true));`,
      },
      { snapshots: { colour: 'red' } },
    );
    const [inTest, flag, setting] = await Promise.all([
      run(app.cwd),
      run(app.cwd, '--snapshot-threshold=2'),
      run(misconfigured.cwd),
    ]);
    const said = (result: { stdout: string; stderr: string }) => result.stdout + result.stderr;

    assert.exitCode(inTest, 0, 'each rejection reached the test that awaited it');
    assert.notEqual(flag.code, 0);
    assert.includes(
      said(flag),
      'Invalid --snapshot-threshold value: "2". Expected a fraction from 0 to 1, got "2".',
    );
    assert.notEqual(setting.code, 0);
    assert.includes(said(setting), 'snapshots.colour: is not a snapshot setting');
  });

  test('each watch rerun compares again', async (assert) => {
    // The color lives in the test file itself: --watch reruns on changes to its inputs.
    const inline = (color: string) =>
      BOX_TEST.replace("import { COLOR } from '../src/state.ts';\n", `const COLOR = '${color}';\n`);
    await using app = await project({ 'test/box-test.ts': inline('rgb(0,0,255)') });
    let changedColor = false;
    const output = await shellWatch(`node ${CWD}/cli.ts test/ --watch`, {
      cwd: app.cwd,
      until: (buf) => {
        if (!changedColor && buf.includes('# Watching files')) {
          changedColor = true;
          app.write('test/box-test.ts', inline('rgb(255,0,0)'));
        }
        return buf.includes('changed: 7,200 pixels');
      },
    });

    assert.includes(output, '# snapshot "box" (Box > is drawn) changed: 7,200 pixels (100.00%)');
  });

  test('through the daemon, whose page is reused run after run', async (assert) => {
    if (process.platform === 'win32' && process.env.QUNITX_BIN?.endsWith('.exe')) {
      return assert.ok(true, 'skipped: daemon tests hang on Windows + deno-compiled binary');
    }
    await using app = await project({
      'test/box-test.ts': BOX_TEST,
      'src/state.ts': `export const COLOR = 'rgb(0,0,255)';`,
    });
    // The runner turns the daemon off for every test (QUNITX_NO_DAEMON); this one wants it.
    const { QUNITX_NO_DAEMON: _off, ...inherited } = process.env;
    const env = { ...inherited, QUNITX_DAEMON: '1', FORCE_COLOR: '0' };
    const daemon = (args: string) =>
      spawnCapture(`node ${CWD}/cli.ts ${args}`, { env, cwd: app.cwd }).catch((error) => error);
    const permit = await acquireBrowser();
    try {
      await daemon('daemon start');
      const first = await daemon('test/');
      const second = await daemon('test/');
      app.write('src/state.ts', `export const COLOR = 'rgb(255,0,0)';`);
      const changed = await daemon('test/');

      assert.includes(
        first.stdout,
        '(daemon)',
        `ran in the daemon: ${first.stdout}${first.stderr}`,
      );
      assert.equal(first.code ?? 0, 0);
      assert.equal(second.code ?? 0, 0);
      assert.equal(changed.code, 1);
      assert.includes(changed.stdout, '# snapshot "box" (Box > is drawn) changed');
    } finally {
      await Client.shutdown(app.cwd).catch(() => {});
      permit.release();
    }
  });
});
