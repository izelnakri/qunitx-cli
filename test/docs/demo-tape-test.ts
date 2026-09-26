import fs from 'node:fs/promises';
import path from 'node:path';
import { module, test } from 'qunitx';
import { captionsOf, panesOf, parseTape, TapeError } from '../../docs/demo/tape.ts';
import { SHOTS } from '../../docs/demo/capture-browser.ts';
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
      Ctrl+C
    `);

    assert.strictEqual(scene!.title, 'Run them');
    assert.strictEqual(scene!.detail, 'in a real browser');
    assert.deepEqual(scene!.steps, [
      { do: 'type', text: 'qunitx test/' },
      { do: 'press', key: 'Enter' },
      { do: 'wait', pattern: /ok 1/ },
      { do: 'sleep', ms: 2500 },
      { do: 'pane', shot: 'green' },
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
    assert.includes(bad('Type "too soon"'), 'before any Caption');
    assert.includes(bad('Caption "only a title"'), 'quoted title and a quoted detail');
  });

  test('the real tape is the demo: seven captions, and every pane has a shot', async (assert) => {
    const scenes = parseTape(await fs.readFile(TAPE, 'utf8'));
    const produced = new Set(
      Object.entries(SHOTS).flatMap(([name, shot]) => shot.produces ?? [name]),
    );

    assert.strictEqual(scenes.length, 7, 'one scene per caption');
    assert.strictEqual(captionsOf(scenes).length, scenes.length);
    for (const pane of panesOf(scenes)) {
      assert.true(produced.has(pane), `${pane} is a shot capture-browser.ts takes`);
    }
    // The other direction too: a shot nothing shows is a minute of recording for nothing.
    for (const [name, shot] of Object.entries(SHOTS)) {
      const shows = (shot.produces ?? [name]).some((pane) => panesOf(scenes).includes(pane));
      assert.true(shows, `the ${name} shot is used by the tape`);
    }
  });
});
