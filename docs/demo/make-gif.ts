// Records docs/demo.gif from docs/demo.tape.
//
//   make demo        (or: node docs/demo/make-gif.ts)
//
// The tape is the demo. This file is the four steps it goes through, and each step lives in its
// own file: `tape.ts` reads the script, `capture-browser.ts` photographs the pages, `record.ts`
// plays each scene into a real terminal, `compose.ts` stitches the result.
//
// Needs ttyd, ffmpeg, gifsicle and bat — all in the nix devShell, and all built on demand if they
// are not — plus a Chrome, and `npx playwright install firefox` for the one Firefox scene.
import { writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import * as Chrome from '../../lib/chrome/index.ts';
import { captionsOf, panesOf, parseTape } from './tape.ts';
import { captionStrip, playScene } from './record.ts';
import { composeScene, stitch } from './compose.ts';
import { IS_NIXOS, run, tool } from './tools.ts';
import { PANE, SHOTS } from './capture-browser.ts';
import type { Recording } from './record.ts';
import type { Scene } from './tape.ts';
import type { Shot } from './capture-browser.ts';

const DEMO = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DEMO, '../..');
const WORK = path.join(DEMO, 'tmp/gif');
const TAPE = path.join(DEMO, 'demo.tape');
const OUTPUT = path.join(ROOT, 'docs/demo.gif');
const TERMINAL = { width: 720, height: 600 };
const CAPTION = { width: TERMINAL.width + PANE.width, height: 56 };
const TEST_FILE = path.join(DEMO, 'test/cart-test.ts');
// The bug the run finds and --watch sees fixed: the test forgot Coffee's quantity.
const WITH_QTY = "{ name: 'Coffee', price: 4, qty: 3 }";
const WITHOUT_QTY = "{ name: 'Coffee', price: 4 }";

const tools = {
  ttyd: tool('ttyd'),
  ffmpeg: tool('ffmpeg'),
  bat: tool('bat'),
  gifsicle: tool('gifsicle'),
  steamRun: IS_NIXOS ? tool('steam-run') : null,
};

const scenes = parseTape(await fs.readFile(TAPE, 'utf8'));
const fixed = await fs.readFile(TEST_FILE, 'utf8');
const buggy = fixed.replace(WITH_QTY, WITHOUT_QTY);
if (buggy === fixed) throw new Error(`${TEST_FILE} no longer contains ${WITH_QTY}`);
// However this ends — a throw, a Ctrl-C — the demo project is left as it was found.
process.on('exit', () => writeFileSync(TEST_FILE, fixed));
process.on('SIGINT', () => process.exit(130));

await fs.rm(WORK, { recursive: true, force: true });
await fs.mkdir(WORK, { recursive: true });
console.log(`==> ${scenes.length} scenes from ${path.relative(ROOT, TAPE)}`);

// 1. The browser panes, grouped by what each shot needs on disk and renders with, so the test
//    file is written once per group — and so a pane added to the tape needs nothing added here.
console.log('==> Capturing the browser pane');
for (const [key, names] of groupShots(shotsFor(scenes))) {
  const [needs, engine] = key.split(':');
  await fs.writeFile(TEST_FILE, needs === 'broken' ? buggy : fixed);
  const wrapper = engine === 'firefox' && tools.steamRun ? tools.steamRun : [];
  const flags = engine === 'firefox' ? ['--engine=firefox'] : [];
  run(
    [...wrapper, process.execPath],
    [path.join(DEMO, 'capture-browser.ts'), WORK, ...flags, ...names],
    DEMO,
  );
}

// 2. The caption strip, then each scene played into a shell of its own.
console.log('==> Recording the terminal');
await fs.writeFile(TEST_FILE, buggy);
const browser = await chromium.launch({ executablePath: (await Chrome.find()) ?? undefined });
const recordings: Recording[] = [];
try {
  await captionStrip(browser, captionsOf(scenes), CAPTION, WORK);
  const stage = {
    browser,
    ttyd: tools.ttyd,
    bashrc,
    terminal: TERMINAL,
    work: WORK,
    cwd: DEMO,
    fix: () => fs.writeFile(TEST_FILE, fixed),
  };
  for (const [index, scene] of scenes.entries()) {
    const carried = recordings.at(-1)?.panes.at(-1);
    recordings.push(await playScene(stage, `scene-${index + 1}`, scene, carried, 4800 + index));
    console.log(`  scene-${index + 1}  ${scene.title}`);
  }
} finally {
  await browser.close();
}

// 3. Each scene composited, then 4. all of them joined into the GIF that ships.
console.log('==> Compositing');
for (const [index, recording] of recordings.entries()) {
  composeScene(tools.ffmpeg, recording, `${WORK}/caption-${index + 1}.png`, WORK, DEMO);
}
stitch(tools, recordings, WORK, OUTPUT, DEMO);
const { size } = await fs.stat(OUTPUT);
const seconds = recordings.reduce((total, { durationMs }) => total + durationMs, 0) / 1000;
console.log(
  `==> ${path.relative(ROOT, OUTPUT)}: ${(size / 1024).toFixed(0)} KB, ${seconds.toFixed(1)}s`,
);

/** The shell each scene starts in: a plain prompt, and `qunitx` meaning this checkout's CLI. */
function bashrc(scene: Scene): string {
  const types = (text: string) => scene.steps.some((s) => s.do === 'type' && s.text.includes(text));
  const qunitx = [
    ...(tools.steamRun && types('firefox') ? tools.steamRun : []),
    process.execPath,
    path.join(ROOT, 'cli.ts'),
  ];

  return [
    String.raw`PS1='\[\e[38;2;189;147;249m\]❯\[\e[0m\] '`,
    'set +m',
    `alias bat='${tools.bat.join(' ')} --paging=never --style=numbers,header,grid'`,
    `alias qunitx='${qunitx.join(' ')}'`,
    '',
  ].join('\n');
}

/** Which shots the tape's panes come from, and the complaint when one of them comes from none. */
function shotsFor(storyboard: Scene[]): [name: string, shot: Shot][] {
  const wanted = panesOf(storyboard);
  const owns = (shot: [string, Shot], pane: string) =>
    (shot[1].produces ?? [shot[0]]).includes(pane);
  const missing = wanted.filter((pane) => !Object.entries(SHOTS).some((s) => owns(s, pane)));
  if (missing.length > 0) {
    throw new Error(`demo.tape names panes no shot takes: ${missing.join(', ')}`);
  }

  return Object.entries(SHOTS).filter((shot) => wanted.some((pane) => owns(shot, pane)));
}

/** `needs:engine` to the shots that want it — one capture-browser run per distinct pair. */
function groupShots(wanted: [string, Shot][]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const [name, shot] of wanted) {
    const key = `${shot.needs}:${shot.engine ?? 'chromium'}`;
    grouped.set(key, [...(grouped.get(key) ?? []), name]);
  }

  return grouped;
}
