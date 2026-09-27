import fs from 'node:fs/promises';
import path from 'node:path';
import { module, test } from 'qunitx';
import { captionsOf, panesOf, parseTape, TapeError } from 'demogod';
import '../helpers/custom-asserts.ts';

const TAPE = path.resolve(import.meta.dirname!, '../../docs/demo/demo.tape');

module('Docs | the demo tape', () => {
  test('a scene is a caption and the keys that follow it', (assert) => {
    const [scene] = parseTape(`
      # the first line is a comment, and blank lines are nothing
      Caption "Run them" "in a real browser"
      Type "qunitx test/"
      Enter
      Wait /ok 1/
      Sleep 2.5s
      Pane green
      Do fix
      Ctrl+C
    `);

    assert.strictEqual(scene!.title, 'Run them');
    assert.strictEqual(scene!.detail, 'in a real browser');
    assert.deepEqual(scene!.steps, [
      { do: 'type', text: 'qunitx test/' },
      { do: 'press', key: 'Enter' },
      { do: 'wait', pattern: /ok 1/ },
      { do: 'sleep', ms: 2500 },
      { do: 'pane', name: 'green' },
      { do: 'action', name: 'fix' },
      { do: 'press', key: 'Control+C' },
    ]);
  });

  test('durations are VHS’s two units, and a pattern is written as one', (assert) => {
    const [scene] = parseTape('Caption "a" "b"\nSleep 400ms\nSleep 3s\nWait /^12$/m');

    assert.deepEqual(scene!.steps[0], { do: 'sleep', ms: 400 });
    assert.deepEqual(scene!.steps[1], { do: 'sleep', ms: 3000 });
    assert.strictEqual((scene!.steps[2] as { pattern: RegExp }).pattern.flags, 'm');
  });

  // A tape is edited by hand, so the answer to a typo is the line it is on.
  test('a bad line says which line, and what it wanted', (assert) => {
    const bad = (source: string) => {
      try {
        parseTape(source);
      } catch (error) {
        return (error as TapeError).message;
      }

      return 'no error';
    };

    assert.includes(bad('Caption "a" "b"\nSleep soon'), 'demo.tape:2');
    assert.includes(bad('Caption "a" "b"\nSleep soon'), 'try 500ms');
    assert.includes(bad('Caption "a" "b"\nWait ok'), 'try /ok 1/');
    assert.includes(bad('Caption "a" "b"\nFly away'), 'no such command: Fly');
    assert.includes(bad('Caption "a" "b"\nPane two words'), 'Pane takes one name');
    assert.includes(bad('Caption "a" "b"\nDo'), 'Do takes one name');
    assert.includes(bad('Type "too soon"'), 'before any Caption');
    assert.includes(bad('Caption "only a title"'), 'quoted title and a quoted detail');
  });

  // The names below are the ones scripts/make-demo-gif.ts declares; `make demo` refuses a tape
  // that asks for any other, and this says which ones the demo is currently built out of.
  test('the real tape is the demo: seven captions, nine panes, two actions', async (assert) => {
    const scenes = parseTape(await fs.readFile(TAPE, 'utf8'));
    const actions = scenes.flatMap(({ steps }) =>
      steps.flatMap((step) => (step.do === 'action' ? [step.name] : [])),
    );

    assert.strictEqual(scenes.length, 7, 'one scene per caption');
    assert.strictEqual(captionsOf(scenes).length, scenes.length);
    assert.deepEqual(panesOf(scenes), [
      'intro',
      'red',
      'green',
      'filtered',
      'firefox',
      'coverage',
      'repl-1',
      'repl-2',
      'repl-3',
    ]);
    assert.deepEqual(actions, ['break', 'fix'], 'the bug goes in, and comes back out');
  });
});
