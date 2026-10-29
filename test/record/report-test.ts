import { module, test } from 'qunitx';
import path from 'node:path';
import {
  COMMENT_MARKER,
  render,
  renderComment,
  type ReportEntry,
} from '../../lib/record/report.ts';
import '../helpers/custom-asserts.ts';

const dir = path.resolve('/shots');
const entry = (
  name: string,
  status: ReportEntry['comparison']['status'],
  changedPixels = 0,
): ReportEntry => {
  const file = path.join(dir, name);
  const stem = file.slice(0, -4);
  return {
    path: file,
    width: 100,
    height: 50,
    comparison: {
      status,
      changedPixels,
      totalPixels: 5000,
      diffPath: status === 'changed' ? `${stem}.diff.png` : null,
      currentPath: status === 'changed' ? `${stem}.new.png` : null,
    },
  };
};

module('Record | report', { concurrency: true }, () => {
  test('changed snapshots come first, with their before-and-after diff and a wipe from baseline to new', (assert) => {
    const html = render(
      [entry('a.png', 'unchanged'), entry('b.png', 'changed', 250), entry('c.png', 'new')],
      {
        directory: dir,
      },
    );

    assert.true(html.indexOf('b.png</h2>') < html.indexOf('c.png</h2>'), 'changed before new');
    assert.true(html.indexOf('c.png</h2>') < html.indexOf('a.png</h2>'), 'new before unchanged');
    assert.includes(html, '<title>1 changed · qunitx snapshots</title>');
    assert.includes(html, '250 pixels · 5.00% · 100×50');
    for (const src of ['src="b.png"', 'src="b.new.png"', 'src="b.diff.png"'])
      assert.includes(html, src);
    assert.includes(html, 'class="wipe"');
    assert.includes(html, '<li class="changed"><b>1</b> changed</li>');
  });

  test('links are relative and escaped, so the folder works from disk or any host', (assert) => {
    const html = render([entry(path.join('mobile', 'a <b> & "c".png'), 'new')], { directory: dir });

    assert.includes(html, 'src="mobile/a%20%3Cb%3E%20%26%20%22c%22.png"');
    assert.includes(html, '<h2>mobile/a &#60;b&#62; &#38; &#34;c&#34;.png</h2>');
    assert.notIncludes(html, '<b> &');
  });

  test('no snapshots at all says so, and neither does a run with no changes', (assert) => {
    assert.includes(render([], { directory: dir }), '<h1>No snapshots</h1>');
    assert.includes(
      render([entry('a.png', 'unchanged')], { directory: dir }),
      '<h1>No visual changes</h1>',
    );
  });
});

module('Record | comment', { concurrency: true }, () => {
  const base = 'https://raw.githubusercontent.com/acme/app/visual/pr-7/run-9/';

  test('each change is its name, its share and its before-and-after diff under the base URL; the marker on top', (assert) => {
    const written = renderComment(
      [entry('a.png', 'unchanged'), entry('b.png', 'changed', 250), entry('c.png', 'new')],
      {
        directory: dir,
        imagesUrl: base,
        reportUrl: 'https://github.com/acme/app/actions/runs/9#artifacts',
      },
    );

    assert.true(written.startsWith(`${COMMENT_MARKER}\n`), 'found again by its marker');
    assert.includes(written, '### Visual changes: 1 of 3 snapshots');
    assert.includes(written, `<img src="${base}b.diff.png"`, 'one image: before and after in one');
    assert.notIncludes(written, `${base}b.png`, 'the diff shows the baseline already');
    assert.notIncludes(written, `${base}a.png`, 'unchanged snapshots are left out');
    assert.includes(written, '250 px · 5.00%');
    assert.includes(written, '1 new snapshot: `c.png`');
    assert.includes(
      written,
      '[Download the full report](https://github.com/acme/app/actions/runs/9#artifacts)',
    );
  });

  test('no changes is one line; without a link there is no link; a base URL gains its slash', (assert) => {
    const written = renderComment([entry('a.png', 'unchanged')], {
      directory: dir,
      imagesUrl: base,
    });
    const nested = entry(path.join('mobile', 'a b.png'), 'changed', 5000);
    const changed = renderComment([nested], { directory: dir, imagesUrl: base.slice(0, -1) });

    assert.includes(written, '### No visual changes in this PR, good job');
    assert.notIncludes(written, 'Download');
    assert.includes(
      changed,
      `src="${base}mobile/a%20b.diff.png"`,
      'nested and escaped, under the slash',
    );
  });
});
