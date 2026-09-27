import { module, test } from 'qunitx';
import { measureWorkspace, paneOfKind, panesOfWorkspace, SIDE_BY_SIDE, stackFilter } from 'demogod';
import type { Workspace } from 'demogod';
import '../helpers/custom-asserts.ts';

const refuses = (workspace: Workspace) => {
  try {
    measureWorkspace(workspace);
  } catch (error) {
    return (error as Error).message;
  }

  return 'no error';
};

module('Docs | the demo workspace', () => {
  test('a row adds up widths, a column adds up heights', (assert) => {
    const side = measureWorkspace({
      row: [
        { terminal: { width: 720, height: 600 } },
        { screenshots: { width: 440, height: 600 } },
      ],
    });
    const stacked = measureWorkspace({
      column: [
        { terminal: { width: 500, height: 400 } },
        { screenshots: { width: 500, height: 200 } },
      ],
    });

    assert.deepEqual(side.dimensions, { width: 1160, height: 600 });
    assert.deepEqual(stacked.dimensions, { width: 500, height: 600 });
  });

  test('a caption spans the column it is stacked in', (assert) => {
    const frame = measureWorkspace(SIDE_BY_SIDE);

    // The demo's own frame, which is what docs/demo.gif measures.
    assert.deepEqual(frame.dimensions, { width: 1160, height: 656 });
    assert.deepEqual(paneOfKind(frame, 'caption')!.dimensions, { width: 1160, height: 56 });
    assert.deepEqual(paneOfKind(frame, 'terminal')!.dimensions, { width: 720, height: 600 });
    assert.deepEqual(paneOfKind(frame, 'screenshots')!.dimensions, { width: 440, height: 600 });
  });

  // ffmpeg's answer to panes that do not line up is an error an hour into a recording, so the
  // answer here is one before anything starts.
  test('panes that cannot be stacked are refused, and say which measurement disagrees', (assert) => {
    assert.includes(
      refuses({
        row: [{ terminal: { width: 8, height: 4 } }, { screenshots: { width: 8, height: 9 } }],
      }),
      'the panes in a row need one height between them, not 4 and 9',
    );
    assert.includes(
      refuses({
        column: [{ terminal: { width: 8, height: 4 } }, { screenshots: { width: 2, height: 4 } }],
      }),
      'the panes in a column need one width between them, not 8 and 2',
    );
    assert.includes(
      refuses({ row: [{ caption: { height: 56 } }, { terminal: { width: 8, height: 56 } }] }),
      'a caption spans a column, so it has to be stacked in one',
    );
  });

  test('a pane asked for twice is an error, and one never used is nothing', (assert) => {
    const twice = measureWorkspace({
      row: [{ terminal: { width: 4, height: 4 } }, { terminal: { width: 4, height: 4 } }],
    });

    assert.throws(() => paneOfKind(twice, 'terminal'), /only have one terminal pane/);
    assert.strictEqual(paneOfKind(twice, 'caption'), undefined, 'no caption is not an error');
  });

  test('the filter stacks the panes in the order ffmpeg reads them', (assert) => {
    const frame = measureWorkspace(SIDE_BY_SIDE);

    assert.deepEqual(
      panesOfWorkspace(frame).map(({ kind }) => kind),
      ['caption', 'terminal', 'screenshots'],
      'input 0 is the caption, 1 the terminal, 2 the browser pane',
    );
    assert.strictEqual(
      stackFilter(frame, 12),
      '[0:v]fps=12,format=rgb24[p0];[1:v]fps=12,format=rgb24[p1];[2:v]fps=12,format=rgb24[p2];' +
        '[p1][p2]hstack=inputs=2:shortest=1[s0];[p0][s0]vstack=inputs=2:shortest=1',
    );
  });

  test('a workspace of one pane needs no stacking at all', (assert) => {
    const frame = measureWorkspace({ terminal: { width: 720, height: 600 } });

    assert.strictEqual(stackFilter(frame, 12), '[0:v]fps=12,format=rgb24');
  });
});
