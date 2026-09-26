// Records docs/demo.gif from docs/demo.tape.
//
//   make demo        (or: node docs/demo/make-gif.ts)
//
// The tape is the demo; this is the studio it is recorded in, and nothing here knows what the
// demo says. Each scene types into a real shell — ttyd, driven by Playwright — while a CDP
// screencast records it, and `Wait` blocks until the terminal shows the pattern, so the browser
// pane switches the moment the matching output does rather than at a guessed offset. That timing
// is why this is not a VHS tape: VHS records one terminal beautifully and hands back a finished
// GIF, with no record of when each wait resolved and no second pane to switch.
//
// Needs ttyd, ffmpeg, gifsicle and bat (all in the nix devShell) and a Chrome. Firefox comes from
// `npx playwright install firefox`, run under steam-run on NixOS.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import * as Chrome from '../../lib/chrome/index.ts';
import { captionsOf, panesOf, parseTape } from './tape.ts';
import type { Scene } from './tape.ts';
import { PANE, SHOTS } from './capture-browser.ts';
import type { Shot } from './capture-browser.ts';

interface Recording {
  name: string;
  frames: { file: string; atMs: number }[];
  panes: { shot: string; atMs: number }[];
  durationMs: number;
}

const DEMO = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DEMO, '../..');
const WORK = path.join(DEMO, 'tmp/gif');
const OUTPUT = path.join(ROOT, 'docs/demo.gif');
const TAPE = path.join(DEMO, 'demo.tape');
const TERMINAL = { width: 720, height: 600 };
const CAPTION = { width: TERMINAL.width + PANE.width, height: 56 };
const FPS = 12;
const TYPING_MS = 35;
const TEST_FILE = path.join(DEMO, 'test/cart-test.ts');
// The bug the run finds and --watch sees fixed: the test forgot Coffee's quantity.
const WITH_QTY = "{ name: 'Coffee', price: 4, qty: 3 }";
const WITHOUT_QTY = "{ name: 'Coffee', price: 4 }";
const IS_NIXOS = existsSync('/etc/NIXOS');
// Dracula, the palette the caption strip and bat's highlighting are chosen around.
const THEME = {
  background: '#282a36',
  foreground: '#f8f8f2',
  cursor: '#f8f8f2',
  selectionBackground: '#44475a',
  black: '#21222c',
  red: '#ff5555',
  green: '#50fa7b',
  yellow: '#f1fa8c',
  blue: '#bd93f9',
  magenta: '#ff79c6',
  cyan: '#8be9fd',
  white: '#f8f8f2',
  brightBlack: '#6272a4',
  brightRed: '#ff6e6e',
  brightGreen: '#69ff94',
  brightYellow: '#ffffa5',
  brightBlue: '#d6acff',
  brightMagenta: '#ff92df',
  brightCyan: '#a4ffff',
  brightWhite: '#ffffff',
};

const tools = {
  ttyd: resolveTool('ttyd'),
  ffmpeg: resolveTool('ffmpeg'),
  bat: resolveTool('bat'),
  gifsicle: resolveTool('gifsicle'),
  steamRun: IS_NIXOS ? resolveTool('steam-run') : null,
};

const scenes = parseTape(await fs.readFile(TAPE, 'utf8'));
const shots = shotsFor(scenes);

const fixed = await fs.readFile(TEST_FILE, 'utf8');
const buggy = fixed.replace(WITH_QTY, WITHOUT_QTY);
if (buggy === fixed) throw new Error(`${TEST_FILE} no longer contains ${WITH_QTY}`);
const source = { broken: buggy, fixed };
process.on('exit', () => writeFileSync(TEST_FILE, fixed));
process.on('SIGINT', () => process.exit(130));

await fs.rm(WORK, { recursive: true, force: true });
await fs.mkdir(WORK, { recursive: true });

console.log(`==> ${scenes.length} scenes from ${path.relative(ROOT, TAPE)}`);

console.log('==> Capturing the browser pane');
// Grouped by what each shot needs on disk and renders with, so the test file is written once per
// group rather than once per shot — and so a pane added to the tape needs nothing added here.
for (const [key, names] of groupShots(shots)) {
  const [needs, engine] = key.split(':');
  await fs.writeFile(TEST_FILE, source[needs as 'broken' | 'fixed']);
  capture(names, engine === 'firefox' ? ['--engine=firefox'] : []);
}

console.log('==> Recording the terminal');
await fs.writeFile(TEST_FILE, buggy);
const browser = await chromium.launch({ executablePath: (await Chrome.find()) ?? undefined });
const recordings: Recording[] = [];
try {
  await captions(browser);
  for (const [index, scene] of scenes.entries()) {
    const carried = recordings.at(-1)?.panes.at(-1);
    recordings.push(await record(`scene-${index + 1}`, scene, carried));
    console.log(`  scene-${index + 1}  ${scene.title}`);
  }
} finally {
  await browser.close();
}

console.log('==> Compositing');
for (const [index, recording] of recordings.entries()) {
  compose(recording, `${WORK}/caption-${index + 1}.png`);
}
await fs.writeFile(
  `${WORK}/scenes.txt`,
  recordings.map(({ name }) => `file '${WORK}/${name}.mkv'`).join('\n'),
);
ffmpeg([
  ...['-f', 'concat', '-safe', '0', '-i', `${WORK}/scenes.txt`],
  ...[
    '-filter_complex',
    '[0:v]split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none',
  ],
  ...['-loop', '0', `${WORK}/demo.gif`],
]);
run(tools.gifsicle, ['-O3', '--lossy=20', `${WORK}/demo.gif`, '-o', OUTPUT]);
const { size } = await fs.stat(OUTPUT);
console.log(`==> ${path.relative(ROOT, OUTPUT)}: ${(size / 1024).toFixed(0)} KB`);

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

/** The strip along the top: one PNG per scene, from the tape's own words. */
async function captions(chrome: Browser): Promise<void> {
  const page = await chrome.newPage({ viewport: CAPTION });
  const all = captionsOf(scenes);
  for (const [index, [title, detail]] of all.entries()) {
    await page.setContent(captionHTML(index, all.length, title, detail));
    await page.screenshot({ path: `${WORK}/caption-${index + 1}.png` });
  }
  await page.close();
}

/** Plays a scene into a fresh shell and returns its frames and pane switches, timed from 0. */
async function record(
  name: string,
  scene: Scene,
  carried: { shot: string } | undefined,
): Promise<Recording> {
  const rcfile = `${WORK}/${name}.bashrc`;
  await fs.writeFile(rcfile, bashrc(scene));
  const port = 4800 + recordings.length;
  const ttyd = spawn(
    tools.ttyd[0],
    [
      ...['--port', String(port), '--interface', '127.0.0.1', '--writable', '--once'],
      ...['-t', 'fontSize=14', '-t', 'fontFamily=DejaVu Sans Mono', '-t', 'lineHeight=1.15'],
      ...['-t', 'cursorBlink=false', '-t', 'disableLeaveAlert=true'],
      ...['-t', 'disableResizeOverlay=true', '-t', `theme=${JSON.stringify(THEME)}`],
      ...['bash', '--rcfile', rcfile, '-i'],
    ],
    { cwd: DEMO, stdio: 'ignore', env: { ...process.env, HISTFILE: '/dev/null' } },
  );
  const page = await browser.newPage({ viewport: TERMINAL });
  try {
    await gotoWhenUp(page, `http://127.0.0.1:${port}/`);
    await page.addStyleTag({
      content: `html, body { background: ${THEME.background}; margin: 0; }
                #terminal-container { box-sizing: border-box; padding: 16px; height: 100vh; }`,
    });
    await page.evaluate(`window.terminalText = ${terminalText}`);
    await page.evaluate(() => globalThis.dispatchEvent(new Event('resize')));
    await waitForTerminal(page, /❯/);

    const frames: Recording['frames'] = [];
    const panes: Recording['panes'] = carried ? [{ shot: carried.shot, atMs: 0 }] : [];
    const cdp = await page.context().newCDPSession(page);
    const start = Date.now();
    cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      const file = `${WORK}/${name}-${String(frames.length).padStart(5, '0')}.png`;
      frames.push({ file, atMs: Date.now() - start });
      writeFileSync(file, data, 'base64');
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });

    for (const step of scene.steps) {
      if (step.do === 'type') await page.keyboard.type(step.text, { delay: TYPING_MS });
      else if (step.do === 'press') await page.keyboard.press(step.key);
      else if (step.do === 'sleep') await page.waitForTimeout(step.ms);
      else if (step.do === 'pane') panes.push({ shot: step.shot, atMs: Date.now() - start });
      else if (step.do === 'fix') await fs.writeFile(TEST_FILE, fixed);
      else await waitForTerminal(page, step.pattern);
    }
    await cdp.send('Page.stopScreencast');
    const durationMs = Date.now() - start;
    // The first frame stands in from 0, so the timeline starts before the first repaint does.
    frames[0].atMs = 0;
    // Off camera: Ctrl-D ends a REPL the scene left open, then the shell, so nothing outlives it.
    for (const _ of [1, 2]) {
      await page.keyboard.press('Control+D');
      await page.waitForTimeout(600);
    }

    return { name, frames, panes: latestAtEachMoment(panes), durationMs };
  } finally {
    await page.close();
    ttyd.kill();
  }
}

/** The shell each scene starts in: a plain prompt, and `qunitx` meaning this checkout's CLI. */
function bashrc(scene: Scene): string {
  const types = (text: string) => scene.steps.some((s) => s.do === 'type' && s.text.includes(text));
  const needsFhs = tools.steamRun && types('firefox');
  const qunitx = [
    ...(needsFhs ? tools.steamRun! : []),
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

/** Caption on top, terminal and browser pane side by side, as a lossless intermediate. */
function compose(recording: Recording, caption: string): void {
  const { name, frames, panes, durationMs } = recording;
  const timeline = (entries: { file: string; atMs: number }[]) =>
    entries
      .map(({ file, atMs }, i) => {
        const next = entries[i + 1]?.atMs ?? durationMs;
        return `file '${file}'\nduration ${((next - atMs) / 1000).toFixed(3)}`;
      })
      // The concat demuxer drops the last entry's duration unless the file is listed once more.
      .concat(`file '${entries.at(-1)!.file}'`)
      .join('\n');
  writeFileSync(`${WORK}/${name}.frames.txt`, timeline(frames));
  writeFileSync(
    `${WORK}/${name}.panes.txt`,
    timeline(panes.map(({ shot, atMs }) => ({ file: `${WORK}/pane-${shot}.png`, atMs }))),
  );
  ffmpeg([
    ...['-loop', '1', '-i', caption],
    ...['-f', 'concat', '-safe', '0', '-i', `${WORK}/${name}.frames.txt`],
    ...['-f', 'concat', '-safe', '0', '-i', `${WORK}/${name}.panes.txt`],
    ...[
      '-filter_complex',
      `[0:v]fps=${FPS},format=rgb24[c];[1:v]fps=${FPS},format=rgb24[t];` +
        `[2:v]fps=${FPS},format=rgb24[b];[t][b]hstack=shortest=1[m];[c][m]vstack=shortest=1`,
    ],
    ...['-t', (durationMs / 1000).toFixed(3), '-c:v', 'ffv1', `${WORK}/${name}.mkv`],
  ]);
}

/** When a scene restates the pane it inherited, the later switch at the same moment wins. */
function latestAtEachMoment(panes: Recording['panes']): Recording['panes'] {
  return panes.filter((entry, i) => panes[i + 1]?.atMs !== entry.atMs);
}

async function waitForTerminal(page: Page, pattern: RegExp): Promise<void> {
  await page.waitForFunction(
    ([source, flags]) =>
      new RegExp(source, flags).test(
        (globalThis as unknown as { terminalText(): string }).terminalText(),
      ),
    [pattern.source, pattern.flags],
    { timeout: 30_000 },
  );
}

async function gotoWhenUp(page: Page, url: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(url);
      await page.waitForFunction(() => 'term' in globalThis);
      return;
    } catch (error) {
      if (attempt === 20) throw error;
      await page.waitForTimeout(100);
    }
  }
}

function capture(names: string[], flags: string[] = []): void {
  const wrapper = flags.includes('--engine=firefox') && tools.steamRun ? tools.steamRun : [];
  run(
    [...wrapper, process.execPath],
    [path.join(DEMO, 'capture-browser.ts'), WORK, ...flags, ...names],
  );
}

function ffmpeg(args: string[]): void {
  run(tools.ffmpeg, ['-y', '-v', 'error', ...args]);
}

function run([command, ...prefix]: string[], args: string[]): void {
  const result = spawnSync(command, [...prefix, ...args], { cwd: DEMO, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
}

/** A tool from PATH, else built from nixpkgs. As argv, so a wrapper fits the same slot. */
function resolveTool(name: string): string[] {
  const onPath = spawnSync('sh', ['-c', `command -v ${name}`])
    .stdout.toString()
    .trim();
  if (onPath) return [onPath];
  const built = spawnSync('nix', ['build', '--no-link', '--print-out-paths', `nixpkgs#${name}`]);
  if (built.status === 0) {
    return [path.join(built.stdout.toString().trim().split('\n')[0], 'bin', name)];
  }

  throw new Error(
    `${name} is needed to record the demo: put it on PATH (it is in the nix devShell)`,
  );
}

function captionHTML(index: number, total: number, title: string, detail: string): string {
  const segments = Array.from(
    { length: total },
    (_, i) => `<span class="${i < index ? 'done' : i === index ? 'now' : ''}"></span>`,
  ).join('');
  return `
    <style>
      body { margin: 0; height: ${CAPTION.height}px; background: #1e1f29; color: #f8f8f2;
             font: 15px/1 system-ui, sans-serif; display: flex; flex-direction: column; }
      .text { flex: 1; display: flex; align-items: center; gap: 12px; padding: 0 18px; }
      .step { color: #6272a4; font-variant-numeric: tabular-nums; }
      .title { font-weight: 700; font-size: 17px; }
      .detail { color: #b4bad0; }
      .progress { display: flex; gap: 3px; height: 4px; }
      .progress span { flex: 1; background: #343746; }
      .progress .done { background: #6d5a9c; }
      .progress .now { background: #bd93f9; }
    </style>
    <div class="text"><span class="step">${index + 1}/${total}</span>
      <span class="title">${title}</span><span class="detail">${detail}</span></div>
    <div class="progress">${segments}</div>`;
}

/** The terminal's whole buffer as text. Its source is installed into the ttyd page, where `term` is xterm.js. */
function terminalText(): string {
  const buffer = (globalThis as unknown as { term: XTerm }).term.buffer.active;
  const lines = [];
  for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)!.translateToString(true));
  return lines.join('\n');
}

interface XTerm {
  buffer: {
    active: {
      length: number;
      getLine(i: number): { translateToString(trimRight: boolean): string } | undefined;
    };
  };
}
