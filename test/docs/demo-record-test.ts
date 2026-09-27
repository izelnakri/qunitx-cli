import { module, test } from 'qunitx';
import { nominalMs, onTapeClock, parseTape, TYPING_MS, WAIT_HOLD_MS } from 'demogod';

// The demo is a recording of real commands, so how long it takes to record is how long they took —
// and that is different on every machine. The same tape came out 64s on an idle box, 78s while it
// was settling and 84s at 2x load. Nothing was wrong with any of them. `retime` is what puts the
// frames on the tape's clock instead, so the GIF is the same wherever it was made.

/** A scene recorded at `speed`: 1 is the tape's own pace, 3 is a machine three times slower. */
function recorded(speed: number): {
  frames: { file: string; atMs: number }[];
  panes: { name: string; atMs: number }[];
  marks: { atMs: number; showMs: number }[];
} {
  const steps = parseTape('Caption "a" "b"\nType "qunitx test/"\nWait /ok 1/\nSleep 2s')[0]!.steps;
  const marks = [{ atMs: 0, showMs: 0 }];
  // A wait scales with the machine; a sleep is a timer and does not.
  const took = (index: number) =>
    [steps[0]!.do === 'type' ? 'qunitx test/'.length * TYPING_MS * speed : 0, 5_000 * speed, 2_000][
      index
    ]!;
  for (const [index, step] of steps.entries()) {
    marks.push({
      atMs: marks.at(-1)!.atMs + took(index),
      showMs: marks.at(-1)!.showMs + nominalMs(step, took(index)),
    });
  }
  const total = marks.at(-1)!.atMs;
  const frames = Array.from({ length: Math.floor(total / 100) + 1 }, (_, i) => ({
    file: `${i}.png`,
    atMs: i * 100,
  }));

  return { frames, panes: [{ name: 'red', atMs: marks[2]!.atMs }], marks };
}

module('Docs | the tape is the clock', () => {
  test('a fast machine and a slow one make the same length of GIF', (assert) => {
    const lengths = [1, 3, 10].map((speed) => {
      const { frames, panes, marks } = recorded(speed);

      return onTapeClock(marks, frames, panes).durationMs;
    });

    // typing + one wait + a two second hold, whatever the machine did.
    const expected = 'qunitx test/'.length * TYPING_MS + WAIT_HOLD_MS + 2_000;
    assert.deepEqual(lengths, [expected, expected, expected]);
  });

  test('a step shows for what the tape says, not what it cost', (assert) => {
    assert.strictEqual(nominalMs({ do: 'sleep', ms: 2_500 }, 9_999), 2_500);
    assert.strictEqual(nominalMs({ do: 'type', text: 'abc' }, 9_999), 3 * TYPING_MS);
    // The one that matters: a wait shows the same whether it waited a moment or a minute.
    assert.strictEqual(nominalMs({ do: 'wait', pattern: /x/ }, 200), WAIT_HOLD_MS);
    assert.strictEqual(nominalMs({ do: 'wait', pattern: /x/ }, 60_000), WAIT_HOLD_MS);
    // And a keypress is not something to stretch to fill a gap.
    assert.strictEqual(nominalMs({ do: 'press', key: 'Enter' }, 4_000), 100);
  });

  test('the pane still switches where the tape puts it', (assert) => {
    for (const speed of [1, 3, 10]) {
      const taken = recorded(speed);
      const { panes } = onTapeClock(taken.marks, taken.frames, taken.panes);

      // After the typing, after the wait — the same instant on every machine.
      assert.deepEqual(panes, [
        { name: 'red', atMs: 'qunitx test/'.length * TYPING_MS + WAIT_HOLD_MS },
      ]);
    }
  });

  test('frames keep their order, and no two land on the same instant', (assert) => {
    const taken = recorded(10);
    const { frames, durationMs } = onTapeClock(taken.marks, taken.frames, taken.panes);

    assert.true(frames.length > 0, 'there are frames left to show');
    assert.true(
      frames.every((frame, i) => i === 0 || frame.atMs > frames[i - 1]!.atMs),
      'each one is later than the one before it',
    );
    assert.true(
      frames.every(({ atMs }) => atMs <= durationMs),
      'and none of them is after the end',
    );
    assert.strictEqual(frames[0]!.atMs, 0, 'the scene starts on its first frame');
  });
});
