import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { testRun } from './helpers.ts';
import { rmRetry } from '../helpers/rm-retry.ts';
import * as QUnitX from '../../lib/api/index.ts';
import '../helpers/custom-asserts.ts';

const CWD = process.cwd();

// A project per test under tmp/, so `qunitx` resolves and each has its own snapshots/.
async function project(color: string, qunitx: Record<string, unknown> = {}) {
  const cwd = path.join(CWD, 'tmp', `api-snapshots-${randomUUID()}`);
  await fs.mkdir(path.join(cwd, 'test'), { recursive: true });
  await fs.symlink(path.join(CWD, 'node_modules'), path.join(cwd, 'node_modules'));
  await fs.writeFile(
    path.join(cwd, 'package.json'),
    JSON.stringify({ name: path.basename(cwd), type: 'module', qunitx }),
  );
  const draw = (fill: string) =>
    fs.writeFile(
      path.join(cwd, 'test', 'box-test.ts'),
      `import { module, test } from 'qunitx';
module('Box', () => {
  test('is drawn', async (assert) => {
    document.body.insertAdjacentHTML('afterbegin', '<div id="box" style="width:80px;height:40px;background:${fill}"></div>');
    const shot = await globalThis.qunitxSnapshot!('box', { selector: '#box' });
    assert.ok(shot);
  });
  test('records', async (assert) => {
    await globalThis.qunitxRecording!.start('step');
    document.getElementById('box')!.style.background = 'orange';
    const step = await globalThis.qunitxRecording!.stop();
    assert.true(step.frames >= 2);
  });
});
`,
    );
  await draw(color);
  return {
    cwd,
    draw,
    [Symbol.asyncDispose]: () => rmRetry(cwd),
  };
}

module('API | snapshots', { concurrency: true }, () => {
  test('the result carries each snapshot and recording; a changed one is ok: false until accepted', async (assert) => {
    await using app = await project('rgb(0,0,255)');
    const once = (snapshots = {}) => testRun({ cwd: app.cwd, inputs: ['test/'], snapshots });
    const first = await once({ report: true });
    await app.draw('rgb(255,0,0)');
    const changed = await once();
    const accepted = await once({ update: true });

    assert.true(first.ok);
    assert.deepEqual(
      first.snapshots.map(({ name, test: by, path: file, width, height, comparison }) => [
        name,
        by,
        path.relative(app.cwd, file),
        width,
        height,
        comparison.status,
      ]),
      [['box', 'Box > is drawn', path.join('snapshots', 'box.png'), 80, 40, 'new']],
    );
    assert.deepEqual(
      first.recordings.map((step) => [step.name, step.test, path.relative(app.cwd, step.path)]),
      [['step', 'Box > records', path.join('snapshots', 'step.gif')]],
    );
    assert.equal(
      path.relative(app.cwd, first.snapshotReportPath!),
      path.join('snapshots', 'report.html'),
    );
    assert.equal(first.snapshotCommentPath, null);
    assert.equal(first.snapshotReportPdfPath, null, 'no report.pdf unless asked for');
    assert.deepEqual(
      [changed.ok, changed.exitCode, changed.counts.failed],
      [false, 1, 0],
      'red, though no test failed',
    );
    assert.equal(changed.snapshots[0].comparison.status, 'changed');
    assert.true(changed.snapshots[0].comparison.changedPixels === 80 * 40);
    assert.deepEqual([accepted.ok, accepted.snapshots[0].comparison.status], [true, 'updated']);
  });

  test('package.json#qunitx.snapshots is read, and the option wins setting by setting', async (assert) => {
    await using app = await project('rgb(0,0,255)', {
      snapshots: { dir: 'visual', prComment: true },
    });
    // The comment is turned on in package.json and told where its images are by the option.
    const result = await testRun({
      cwd: app.cwd,
      inputs: ['test/'],
      snapshots: { dir: 'shots', imagesUrl: 'https://example.com/visual/' },
    });

    assert.equal(path.relative(app.cwd, result.snapshots[0].path), path.join('shots', 'box.png'));
    assert.equal(
      path.relative(app.cwd, result.snapshotCommentPath!),
      path.join('shots', 'comment.md'),
    );
  });

  test('a bad snapshots option rejects the run, naming it', async (assert) => {
    await using app = await project('rgb(0,0,255)');
    const failure = (await QUnitX.test({
      cwd: app.cwd,
      inputs: ['test/'],
      snapshots: { threshold: 5 },
    }).result()) as Error & {
      code: string;
    };

    const commentWithoutImages = (await QUnitX.test({
      cwd: app.cwd,
      inputs: ['test/'],
      snapshots: { prComment: true },
    }).result()) as Error;

    assert.equal(failure.code, 'InvalidSnapshotSetting');
    assert.equal(failure.message, 'snapshots.threshold: expected a fraction from 0 to 1, got 5');
    assert.equal(
      commentWithoutImages.message,
      'snapshots.prComment: needs imagesUrl (--snapshot-images-url), where the snapshot images are published for it to link to',
    );
  });
});
