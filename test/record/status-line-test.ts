import { module, test } from 'qunitx';
import * as StatusLine from '../../lib/commands/record/status-line.ts';
import { enterPhase, progress } from '../../lib/record/progress.ts';

module('Record | status line', { concurrency: true }, () => {
  test('a phase without a total shows how long it has taken; one with a total, a bar', (assert) => {
    assert.equal(
      StatusLine.render({ phase: 'recording shop', done: 0, total: null }, 6_040, 80, 0),
      '⠋ recording shop  6.0s',
    );
    assert.equal(
      StatusLine.render({ phase: 'encoding shop.gif', done: 48, total: 96 }, 12_300, 80, 1),
      '⠙ encoding shop.gif ▕██████████░░░░░░░░░░▏ 50%  12.3s',
    );
    assert.equal(
      StatusLine.render({ phase: 'drawing shop', done: 96, total: 96 }, 0, 80, 10),
      '⠋ drawing shop ▕████████████████████▏ 100%  0.0s',
    );
  });

  test('it is cut to the terminal, so it can be redrawn in place', (assert) => {
    const line = StatusLine.render(
      { phase: 'recording '.repeat(10), done: 0, total: null },
      0,
      30,
      0,
    );

    assert.equal(line.length, 29);
  });

  test('a phase starts from nothing done', (assert) => {
    enterPhase('drawing a', 4);
    progress.done = 3;
    enterPhase('encoding a.gif', 10);

    assert.deepEqual({ ...progress }, { phase: 'encoding a.gif', done: 0, total: 10 });
  });
});
