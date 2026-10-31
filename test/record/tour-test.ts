import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  Timeline,
  ease,
  frameCount,
  handLayout,
  pinchLayout,
  keyLabels,
  menuItemPoint,
  menuLayout,
  zoomedCamera,
} from '../../lib/record/tour/timeline.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import * as PNG from '../../lib/record/png.ts';
import {
  DEFAULT_LOOK,
  definitionOf,
  framedSize,
  lookOf,
  readCursorImage,
  resolveFrame,
  tour,
} from '../../lib/record/tour/index.ts';

const tabs = { titles: ['Home'], active: 0, url: 'http://localhost/' };
const viewport = { width: 1000, height: 600 };
const total = (timeline: Timeline) =>
  timeline.beats.reduce((sum, beat) => sum + beat.durationMs, 0);

module('Record | tour | timeline', { concurrency: true }, () => {
  test('a step gets one frame per tick of the frame rate, at least one, eased at both ends', (assert) => {
    assert.deepEqual([frameCount(600, 10), frameCount(10, 10), frameCount(1000, 25)], [6, 1, 25]);
    assert.deepEqual([ease(0), ease(1)], [0, 1]);
    assert.true(ease(0.1) < 0.1 && ease(0.9) > 0.9, 'slow out of the start, slow into the end');
    const samples = [0, 0.2, 0.4, 0.6, 0.8, 1].map(ease);
    assert.true(
      samples.every((value, index) => index === 0 || value > samples[index - 1]),
      'never backwards',
    );
  });

  test('a zoom centers on its target and stops at the page edge rather than showing past it', (assert) => {
    assert.deepEqual(zoomedCamera({ x: 450, y: 250, width: 100, height: 100 }, 2, viewport), {
      x: 250,
      y: 150,
      width: 500,
      height: 300,
    });
    const corner = zoomedCamera({ x: 980, y: 590, width: 10, height: 10 }, 4, viewport);
    assert.deepEqual([corner.x, corner.y], [750, 450], 'pinned to the bottom-right');
  });

  test('a move lands exactly on its target over its own duration, frame by frame', (assert) => {
    const timeline = new Timeline(viewport, 10, tabs);
    const start = timeline.cursor!;
    timeline.move({ x: 500, y: 300 }, 600);
    const xs = timeline.beats.map((beat) => beat.cursor!.x);

    assert.equal(timeline.beats.length, 6);
    assert.deepEqual(timeline.beats.at(-1)!.cursor, { x: 500, y: 300 });
    assert.true(
      xs[0] > start.x && xs.every((x, index) => index === 0 || x > xs[index - 1]),
      'moves steadily on',
    );
    assert.equal(total(timeline), 600);
  });

  test('the camera eases to its target, and a frame that changes nothing only lengthens the last', (assert) => {
    const timeline = new Timeline(viewport, 10, tabs);
    const zoomed = zoomedCamera({ x: 0, y: 0, width: 100, height: 100 }, 2, viewport);
    timeline.camera(zoomed, 400);
    timeline.hold(500);
    timeline.hold(500);

    assert.deepEqual(timeline.beats.at(-1)!.camera, zoomed);
    assert.equal(timeline.beats.length, 4, 'four zoom frames; the two holds join the last');
    assert.equal(timeline.beats.at(-1)!.durationMs, 1100);
    assert.equal(total(timeline), 1400);
  });

  test('a click ripples outward; captions, screenshots and tabs carry into every beat after them', (assert) => {
    const timeline = new Timeline(viewport, 10, tabs);
    timeline.ripple(300);
    timeline.caption('Add to cart');
    timeline.show(3, { titles: ['Home', 'Checkout'], active: 1, url: 'http://localhost/checkout' });
    timeline.hold(200);

    assert.deepEqual(
      timeline.beats.slice(0, 3).map((beat) => beat.ripple),
      [1 / 3, 2 / 3, 1],
    );
    assert.deepEqual(
      [timeline.beats.at(-1)!.ripple, timeline.beats.at(-1)!.caption, timeline.beats.at(-1)!.shot],
      [null, 'Add to cart', 3],
    );
    assert.equal(timeline.beats.at(-1)!.tabs.active, 1);
  });
});

module('Record | tour | definition', { concurrency: true }, () => {
  test('a tour file exports tour(...) or a plain async function; anything else says what it needs', (assert) => {
    const run = async () => {};

    assert.deepEqual(tour(run), { options: {}, run });
    assert.deepEqual(tour({ touch: true }, run), { options: { touch: true }, run });
    assert.deepEqual(definitionOf({ default: run }), { options: {}, run });
    assert.deepEqual(definitionOf({ default: tour({ frame: 'none' }, run) }), {
      options: { frame: 'none' },
      run,
    });
    assert.equal(
      definitionOf({}),
      'it must export default an async function, or tour(...) from qunitx-cli',
    );
  });
});

module('Record | tour | touch and frames', { concurrency: true }, () => {
  test('a finger shows only while it touches; a cursor is always on screen', (assert) => {
    const finger = new Timeline(viewport, 10, tabs, 'finger');
    const cursor = new Timeline(viewport, 10, tabs);
    finger.hold(100);
    finger.pointerAt({ x: 200, y: 300 });
    finger.ripple(200);
    finger.pointerAt(null);
    finger.hold(100);

    assert.equal(cursor.cursor !== null, true, 'the cursor starts on screen');
    assert.deepEqual(
      finger.beats.map((beat) => beat.cursor),
      [null, { x: 200, y: 300 }, { x: 200, y: 300 }, null],
      'no finger, the finger down through its ripple, lifted',
    );
  });

  test("'auto' picks a phone for touch, a browser window for a second tab, else nothing", (assert) => {
    assert.deepEqual(
      [resolveFrame({}, 1), resolveFrame({}, 2), resolveFrame({ touch: true }, 3)],
      ['none', 'browser', 'phone'],
    );
    assert.deepEqual(
      [resolveFrame({ frame: 'browser' }, 1), resolveFrame({ touch: true, frame: 'none' }, 1)],
      ['browser', 'none'],
      'an explicit frame always wins',
    );
  });

  test('every frame kind has a fixed size, so every frame of a recording matches', (assert) => {
    const page = { width: 390, height: 600 };

    assert.deepEqual(framedSize('none', page), page);
    assert.deepEqual(framedSize('browser', page), { width: 390, height: 674 });
    assert.deepEqual(framedSize('phone', page), { width: 450, height: 704 });
    assert.deepEqual(framedSize('browser', page, false), { width: 390, height: 636 }, 'tabs only');
    assert.deepEqual(framedSize('phone', page, false), { width: 450, height: 660 }, 'no bar');
  });
});

module('Record | tour | menus', { concurrency: true }, () => {
  test('a menu opens below-right of the pointer, and flips at the page edges like a real one', (assert) => {
    const items = ['Copy', 'Paste', 'Delete'];
    const open = menuLayout({ x: 100, y: 100 }, items, viewport);
    const corner = menuLayout({ x: 990, y: 590 }, items, viewport);

    assert.deepEqual([open.x, open.y, open.width, open.itemHeight], [104, 104, 200, 30]);
    assert.true(corner.x + corner.width <= viewport.width && corner.y >= 0, 'kept on the page');
    assert.true(corner.x < 990 && corner.y < 590, 'opened up and to the left');
    assert.equal(
      menuLayout({ x: 100, y: 100 }, items, viewport, 320).width,
      320,
      "a select's list as wide as the select",
    );
  });

  test('each item is clicked in its own row, and a drawn menu carries until closed', (assert) => {
    const menu = menuLayout({ x: 100, y: 100 }, ['Copy', 'Paste', 'Delete'], viewport);
    const rows = [0, 1, 2].map((index) => menuItemPoint(menu, index));
    const timeline = new Timeline(viewport, 10, tabs);
    timeline.menu(menu);
    timeline.hold(100);
    timeline.menu(null);
    timeline.hold(100);

    rows.forEach((point, index) => {
      assert.true(
        point.x > menu.x && point.x < menu.x + menu.width,
        `item ${index} within the menu`,
      );
      assert.true(
        point.y > menu.y + index * 30 && point.y < menu.y + (index + 1) * 30 + 8,
        `in row ${index}`,
      );
    });
    assert.deepEqual(
      timeline.beats.map((beat) => beat.menu?.items ?? null),
      [menu.items, null],
    );
  });
});

module('Record | tour | look', { concurrency: true }, () => {
  test('without options, the defaults; each part takes its own CSS, sizes and choices', (assert) => {
    const look = lookOf(
      {
        cursor: { size: 40, style: { color: '#e03131', strokeWidth: 2 } },
        finger: { size: 60, style: { background: 'rgba(255,0,0,.3)' } },
        ripple: { style: { color: '#0c8' } },
        caption: { placement: 'top', style: { borderRadius: 0, fontFamily: 'Georgia, serif' } },
        menu: { highlightStyle: { background: '#2f9e44' } },
        phone: { backdrop: 'linear-gradient(#fff, #ddd)' },
        browser: { theme: 'dark' },
        css: '#url { display: none; }',
      },
      '/proj',
    );

    assert.deepEqual(lookOf({}, '/proj'), DEFAULT_LOOK);
    assert.deepEqual(look.cursor, {
      ...DEFAULT_LOOK.cursor,
      size: 40,
      style: { color: '#e03131', strokeWidth: 2 },
    });
    assert.deepEqual(look.finger, {
      size: 60,
      spacing: null,
      labels: false,
      style: { background: 'rgba(255,0,0,.3)' },
    });
    assert.deepEqual(look.ripple, { style: { color: '#0c8' } });
    assert.deepEqual(look.caption, {
      placement: 'top',
      style: { borderRadius: 0, fontFamily: 'Georgia, serif' },
    });
    assert.deepEqual(look.menu, { style: {}, highlightStyle: { background: '#2f9e44' } });
    assert.deepEqual(look.phone, { backdrop: 'linear-gradient(#fff, #ddd)', style: {} });
    assert.deepEqual(look.browser, { theme: 'dark', style: {} });
    assert.equal(look.css, '#url { display: none; }');
    assert.equal(lookOf({ ripple: false }, '/proj').ripple, null, 'no ripple at all');
    assert.deepEqual(
      lookOf({ caption: { style: { color: undefined } } }, '/proj').caption.style,
      {},
      'undefined is not a value',
    );
  });

  test('a cursor image is read relative to the tour, with its hotspot; bad ones are refused by name', async (assert) => {
    await using dir = await tempDir('tour-cursor-image');
    await fs.writeFile(
      path.join(dir.path, 'hand.png'),
      await PNG.encode({ width: 1, height: 1, data: Uint8Array.of(0, 255, 255, 255) }),
    );
    const styled = await readCursorImage(
      lookOf({ cursor: { image: 'hand.png', hotspot: { x: 6, y: 1 } } }, dir.path),
    );

    assert.true(styled.cursor.image!.startsWith('data:image/png;base64,'));
    assert.deepEqual(styled.cursor.hotspot, { x: 6, y: 1 });
    assert.deepEqual(
      lookOf({ cursor: { image: 'https://cdn.test/hand.svg' } }, dir.path).cursor.image,
      'https://cdn.test/hand.svg',
    );
    assert.deepEqual(
      lookOf({ cursor: { image: 'https://cdn.test/hand.svg' } }, dir.path).cursor.hotspot,
      { x: 0, y: 0 },
    );
    await assert.rejects(
      readCursorImage(lookOf({ cursor: { image: 'missing.png' } }, dir.path)),
      /cursor\.image missing\.png: no such file/,
    );
    assert.throws(
      () => lookOf({ cursor: { image: 'hand.bmp' } }, dir.path),
      /expected a \.png, \.svg, \.jpg, \.webp or \.gif/,
    );
    assert.throws(
      () => lookOf({ cursor: { size: 2 } }, dir.path),
      /cursor\.size must be a number of CSS pixels from 8 to 256, not 2/,
    );
    assert.throws(() => lookOf({ finger: { size: 999 } }, dir.path), /finger\.size must be/);
  });

  test('a choice outside its options, or a declaration that is not a string or number, is refused by name', (assert) => {
    assert.throws(
      () => lookOf({ caption: { placement: 'middle' as 'top' } }, '/proj'),
      /caption\.placement must be 'bottom', 'top' or 'panel', not 'middle'/,
    );
    assert.throws(
      () => lookOf({ browser: { theme: 'blue' as 'dark' } }, '/proj'),
      /browser\.theme must be 'light' or 'dark', not 'blue'/,
    );
    assert.throws(
      () => lookOf({ menu: { style: { padding: [4, 8] as unknown as string } } }, '/proj'),
      /menu\.style\.padding must be a string or a number, not object/,
    );
  });
});

module('Record | tour | highlights, keystrokes and chapters', { concurrency: true }, () => {
  const box = { x: 100, y: 100, width: 200, height: 50 };

  test('a highlight fades in, moves to the next target already lit, and fades out on null', (assert) => {
    const timeline = new Timeline(viewport, 10, tabs);
    timeline.highlight(box, 300);
    const fadedIn = timeline.beats.map((beat) => beat.highlight!.strength);
    timeline.highlight({ x: 500, y: 300, width: 100, height: 100 }, 300);
    const moving = timeline.beats.slice(3).map((beat) => beat.highlight!);
    timeline.highlight(null, 300);
    timeline.hold(100);

    assert.true(
      fadedIn.every((strength, index) => index === 0 || strength > fadedIn[index - 1]),
      'brighter every frame',
    );
    assert.equal(fadedIn.at(-1), 1);
    assert.true(
      moving.every(({ strength }) => strength === 1),
      'stays lit while it moves',
    );
    assert.deepEqual(moving.at(-1)!.rect, { x: 500, y: 300, width: 100, height: 100 });
    assert.equal(timeline.beats.at(-2)!.highlight!.strength, 0, 'faded out where it was');
    assert.equal(timeline.beats.at(-1)!.highlight, null, 'then gone');
    assert.equal(total(timeline), 1000);
  });

  test('a lit highlight is moved at once as its target scrolls; with none lit, nothing appears', (assert) => {
    const timeline = new Timeline(viewport, 10, tabs);
    timeline.highlightAt(box);
    timeline.hold(100);
    timeline.highlight(box, 300);
    timeline.highlightAt({ ...box, y: 40 });
    timeline.hold(100);

    assert.equal(timeline.beats[0].highlight, null);
    assert.deepEqual(timeline.beats.at(-1)!.highlight, { rect: { ...box, y: 40 }, strength: 1 });
  });

  test('a chapter fades in, holds, fades out, for exactly its duration, and leaves nothing behind', (assert) => {
    const timeline = new Timeline(viewport, 10, tabs);
    timeline.chapter('Checkout', 'Paying for it', 2000, 300);
    timeline.hold(100);
    const strengths = timeline.beats.map((beat) => beat.chapter?.strength ?? null);
    const short = new Timeline(viewport, 10, tabs);
    short.chapter('Quick', null, 200, 300);

    assert.deepEqual(timeline.beats[0].chapter!.title, 'Checkout');
    assert.equal(timeline.beats[0].chapter!.subtitle, 'Paying for it');
    assert.true(strengths[0]! > 0 && strengths[0]! < 1, 'fading in');
    assert.true(strengths.includes(1), 'held at full');
    assert.equal(strengths.at(-1), null, 'gone after it');
    assert.equal(total(timeline), 2100);
    assert.equal(total(short), 200, 'its fades take no more than it has');
  });

  test('a keystroke is a badge per key, written as a keyboard shows it', (assert) => {
    assert.deepEqual(keyLabels('Control+K'), ['Ctrl', 'K']);
    assert.deepEqual(keyLabels('Meta+Shift+ArrowUp'), ['⌘', 'Shift', '↑']);
    assert.deepEqual(keyLabels('Control++'), ['Ctrl', '+']);
    assert.deepEqual(keyLabels('+'), ['+']);
    assert.deepEqual(keyLabels('Enter'), ['Enter ↵']);
    assert.deepEqual(keyLabels('F5'), ['F5']);
  });

  test('each takes its own style, and keystroke badges can be turned off', (assert) => {
    const look = lookOf(
      {
        highlight: { style: { outlineColor: '#e03131' } },
        keys: { style: { bottom: 40 } },
        chapter: { style: { background: '#5f3dc4' } },
      },
      '/proj',
    );

    assert.deepEqual(
      [look.highlight, look.keys, look.chapter],
      [
        { style: { outlineColor: '#e03131' } },
        { style: { bottom: 40 } },
        { style: { background: '#5f3dc4' } },
      ],
    );
    assert.equal(lookOf({ keys: false }, '/proj').keys, null);
  });
});

module('Record | tour | fingers', { concurrency: true }, () => {
  const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);

  test('a hand lays its fingers in a row across the way it moves, centered, the middle ones ahead', (assert) => {
    for (const count of [1, 2, 3, 5, 10]) {
      const hand = handLayout({ x: 200, y: 200 }, count, 50, 0);
      const across = hand.map((point) => point.y);

      assert.equal(hand.length, count);
      assert.true(
        across.every((y, index) => index === 0 || Math.abs(y - across[index - 1] - 50) < 1e-9),
        `${count}: each 50 below the last, across a rightward move`,
      );
      assert.true(
        Math.abs(across.reduce((sum, y) => sum + y, 0) / count - 200) < 1e-9,
        `${count}: centered`,
      );
    }
    const five = handLayout({ x: 0, y: 0 }, 5, 40, 0).map((point) => point.x);
    assert.true(
      five[2] > five[1] && five[1] > five[0] && five[0] === five[4],
      'arched: the middle finger furthest ahead',
    );
    const down = handLayout({ x: 0, y: 0 }, 3, 40, Math.PI / 2);
    assert.true(
      down.every((point, index) => index === 0 || Math.abs(point.y - down[0].y) < 20),
      'turned with the move',
    );
  });

  test('a pinch sets its fingers evenly round a circle, two of them left and right', (assert) => {
    const ten = pinchLayout({ x: 100, y: 100 }, 10, 60, 0.3);
    const gaps = ten.map((point, index) => distance(point, ten[(index + 1) % 10]));

    assert.true(
      ten.every((point) => Math.abs(distance(point, { x: 100, y: 100 }) - 60) < 1e-9),
      'all on the circle',
    );
    assert.true(
      gaps.every((gap) => Math.abs(gap - gaps[0]) < 1e-9),
      'evenly spread',
    );
    assert.deepEqual(
      pinchLayout({ x: 100, y: 100 }, 2, 30, 0).map((point) => [
        Math.round(point.x),
        Math.round(point.y),
      ]),
      [
        [70, 100],
        [130, 100],
      ],
    );
  });

  test('finger spacing and labels are options, held to rules', (assert) => {
    const look = lookOf({ finger: { spacing: 60, labels: true } }, '/proj');

    assert.deepEqual([look.finger.spacing, look.finger.labels], [60, true]);
    assert.deepEqual([DEFAULT_LOOK.finger.spacing, DEFAULT_LOOK.finger.labels], [null, false]);
    assert.throws(
      () => lookOf({ finger: { spacing: 2 } }, '/proj'),
      /finger\.spacing must be a number of CSS pixels from 8 to 256/,
    );
    assert.throws(
      () => lookOf({ finger: { labels: 'yes' as unknown as boolean } }, '/proj'),
      /finger\.labels must be true or false, not "yes"/,
    );
  });
});
