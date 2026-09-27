import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, firefox } from 'playwright-core';
import { captionsOf, nominalMs, onTapeClock, panesOf, parseTape, TYPING_MS } from './tape.ts';
import {
  measureWorkspace,
  paneOfKind,
  panesOfWorkspace,
  SIDE_BY_SIDE,
  stackFilter,
} from './workspace.ts';
import type { Browser, Page } from 'playwright-core';
import type { Scene } from './tape.ts';
import type { Dimensions, MeasuredWorkspace, Workspace } from './workspace.ts';

// The machine: a tape and a storyboard in, a GIF out.
//
// Nothing here knows what is being demonstrated. The tape says what happens and in what order, and
// the {@link Storyboard} says what the names in it mean — `scripts/make-demo-gif.ts` in this
// repository is one filled in.

/** How many frames a second the finished GIF runs at. */
const FPS = 12;
/** Generous, and it can afford to be: a slow machine no longer makes a slower GIF, so the only
 * thing waiting longer costs is the recording taking longer. At 30s a busy laptop gave up
 * partway through with a TimeoutError instead of finishing. */
const TERMINAL_TIMEOUT_MS = 90_000;
const IS_NIXOS = existsSync('/etc/NIXOS');
/** The terminal's colours, and the palette the caption strip is chosen around. Dracula. */
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

/** Which browser a pane is photographed with. The recording itself is always Chrome. */
export type Engine = 'chromium' | 'firefox';

/** The pane being filled in: where to put its picture, how big, and a browser on request. */
export interface Pane {
  /** The PNG to write. Whatever ends up here is what `Pane <name>` shows. */
  readonly file: string;
  /** What that picture has to measure, which is the pane's rectangle in the GIF. */
  readonly dimensions: Dimensions;
  /** The directory the demo's commands run in. */
  readonly cwd: string;
  /** Somewhere to put working files. Emptied at the start of every `make demo`. */
  readonly tmp: string;
  /** A browser, started on the first ask and shared by every pane after it. */
  browser(engine?: Engine): Promise<Browser>;
}

/** Takes the one picture a `Pane <name>` shows. */
export type CapturePane = (pane: Pane) => Promise<void>;

/** Everything a tape leaves to the person using it. */
export interface Storyboard {
  /** The `.tape` to read. */
  tape: string;
  /** The GIF to write. */
  gif: string;
  /** The directory the terminal starts in, and every command runs in. */
  cwd: string;
  /** How the frame is divided into panes. Defaults to {@link SIDE_BY_SIDE}. */
  workspace?: Workspace;
  /** The Chrome to record with, and to photograph Chromium panes with. Defaults to the one
   *  Playwright downloads. */
  chromePath?: string;
  /** Every pane the tape may switch to, under the name it switches to it by. */
  panes: Record<string, CapturePane>;
  /** Every action the tape may `Do`, run off camera between two keystrokes. */
  actions?: Record<string, () => Promise<void>>;
  /** Lines added to the shell a scene is typed into — aliases, a PATH, whatever it needs. */
  shellLines?: (scene: Scene) => string[];
}

/** One scene, recorded: its frames, when the pane changed, and how long it runs for. */
interface Recording {
  name: string;
  frames: { file: string; atMs: number }[];
  panes: { name: string; atMs: number }[];
  durationMs: number;
}

/**
 * A demo being made. Three steps, in the order `scripts/make-demo-gif.ts` calls them.
 *
 * Named the same as the {@link Demo} below it on purpose: a type and a value can share a name, so
 * `Demo.open()` returns a `Demo` and there is one word for the thing either way.
 */
export interface Demo {
  /** The scenes the tape describes, for anything that wants to say how many there are. */
  readonly scenes: readonly Scene[];
  /** Runs every capture the tape asks for — one PNG per pane. */
  capturePanes(): Promise<void>;
  /** Types every scene into a real terminal and records it. */
  recordScenes(): Promise<void>;
  /** Stitches caption, terminal and pane into the GIF, and says how big it came out. */
  saveGif(): Promise<{ kb: number; seconds: number }>;
  /** Closes whatever browsers the panes and the recording asked for. */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Opens a demo: reads the tape, measures the workspace, finds ttyd and ffmpeg, clears tmp.
 *
 * Nothing is started here — a browser comes up on the first step that needs one.
 *
 * ```ts
 * import { Demo } from 'demogod';
 *
 * // Defined, not invoked: it starts browsers and a terminal.
 * async function example(storyboard: Storyboard) {
 *   await using demo = await Demo.open(storyboard);
 *
 *   return demo.scenes.length;
 * }
 * ```
 */
export const Demo = { open };

async function open(storyboard: Storyboard): Promise<Demo> {
  const { cwd, panes } = storyboard;
  const scenes = parseTape(await fs.readFile(storyboard.tape, 'utf8'));
  const usedPanes = panesOf(scenes);
  const undeclared = usedPanes.filter((name) => !(name in panes));
  if (undeclared.length > 0) {
    throw new Error(`${storyboard.tape} switches to panes nothing takes: ${undeclared.join(', ')}`);
  }

  const frame = measureWorkspace(storyboard.workspace ?? SIDE_BY_SIDE);
  const terminalPane = paneOfKind(frame, 'terminal');
  const screenshotsPane = paneOfKind(frame, 'screenshots');
  const captionPane = paneOfKind(frame, 'caption');
  if (!terminalPane) throw new Error('the workspace has no terminal pane to type the tape into');
  if (usedPanes.length > 0 && !screenshotsPane) {
    throw new Error(`${storyboard.tape} switches panes, but the workspace has no screenshots pane`);
  }

  const tmp = path.join(cwd, 'tmp/gif');
  const programs = {
    ttyd: findProgram('ttyd'),
    ffmpeg: findProgram('ffmpeg'),
    gifsicle: findProgram('gifsicle'),
  };
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true });

  const browsers = new Map<Engine, Browser>();
  const browserFor = async (engine: Engine = 'chromium'): Promise<Browser> => {
    browsers.set(engine, browsers.get(engine) ?? (await launchBrowser(engine, storyboard, tmp)));

    return browsers.get(engine)!;
  };
  const recordings: Recording[] = [];

  return {
    scenes,

    async capturePanes() {
      for (const [name, capture] of Object.entries(panes)) {
        if (!usedPanes.includes(name)) {
          console.log(`  ${name} — nothing shows it, skipped`);
          continue;
        }
        await capture({
          file: `${tmp}/pane-${name}.png`,
          dimensions: screenshotsPane!.dimensions,
          cwd,
          tmp,
          browser: browserFor,
        });
        console.log(`  ${name}`);
      }
    },

    async recordScenes() {
      if (captionPane) {
        await renderCaptionStrip(
          await browserFor(),
          tmp,
          captionPane.dimensions,
          captionsOf(scenes),
        );
      }
      for (const [index, scene] of scenes.entries()) {
        recordings.push(
          await recordScene(await browserFor(), scene, {
            sceneName: `scene-${index + 1}`,
            port: 4800 + index,
            carriedPane: recordings.at(-1)?.panes.at(-1),
            storyboard,
            terminal: terminalPane.dimensions,
            tmp,
            ttyd: programs.ttyd,
          }),
        );
        console.log(`  scene-${index + 1}  ${scene.title}`);
      }
    },

    async saveGif() {
      for (const [index, recording] of recordings.entries()) {
        composeScene(programs.ffmpeg, cwd, tmp, frame, recording, index);
      }
      stitchGif(programs, cwd, tmp, recordings, storyboard.gif);
      const { size } = await fs.stat(storyboard.gif);

      return {
        kb: Math.round(size / 1024),
        seconds: recordings.reduce((total, { durationMs }) => total + durationMs, 0) / 1000,
      };
    },

    async [Symbol.asyncDispose]() {
      for (const browser of browsers.values()) await browser.close();
    },
  };
}

// ── the outside world ───────────────────────────────────────────────────────────────────────

/**
 * Where a program is: one from PATH, else built from nixpkgs, so a checkout without it still
 * records.
 */
export function findProgram(name: string): string {
  const onPath = spawnSync('sh', ['-c', `command -v ${name}`])
    .stdout.toString()
    .trim();
  if (onPath) return onPath;

  const built = spawnSync('nix', ['build', '--no-link', '--print-out-paths', `nixpkgs#${name}`]);
  if (built.status === 0) {
    return path.join(built.stdout.toString().trim().split('\n')[0]!, 'bin', name);
  }

  throw new Error(
    `${name} is needed to record the demo: put it on PATH (it is in the nix devShell)`,
  );
}

/**
 * The same command, but able to run on NixOS.
 *
 * Prebuilt binaries — Playwright's browsers, most downloaded tarballs — are linked against the
 * `/usr/lib` layout NixOS does not have, so there they go under steam-run's FHS environment.
 * Anywhere else this is the command unchanged.
 */
export function runInFHS(command: readonly string[]): string[] {
  return IS_NIXOS ? [findProgram('steam-run'), ...command] : [...command];
}

/** A browser to photograph with. Chrome is the one already installed; Firefox is Playwright's. */
async function launchBrowser(
  engine: Engine,
  storyboard: Storyboard,
  tmp: string,
): Promise<Browser> {
  if (engine === 'chromium') {
    return chromium.launch({ executablePath: storyboard.chromePath });
  } else if (!IS_NIXOS) {
    return firefox.launch();
  }

  // Two NixOS details, and neither applies anywhere else: Playwright's Firefox needs an FHS
  // environment, and from inside one it cannot see the host's /tmp — where Playwright would
  // otherwise put the profile it is about to tell Firefox to open.
  const wrapper = path.join(tmp, 'firefox');
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${runInFHS([firefox.executablePath()]).join(' ')} "$@"\n`,
    {
      mode: 0o755,
    },
  );
  const host = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  try {
    return await firefox.launch({ executablePath: wrapper });
  } finally {
    if (host === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = host;
  }
}

// ── recording ───────────────────────────────────────────────────────────────────────────────

/** The strip along the top: one PNG per scene, from the tape's own words. */
async function renderCaptionStrip(
  browser: Browser,
  tmp: string,
  dimensions: Dimensions,
  captions: readonly [title: string, detail: string][],
): Promise<void> {
  const page = await browser.newPage({ viewport: dimensions });
  for (const [index, [title, detail]] of captions.entries()) {
    await page.setContent(buildCaptionHTML(dimensions, index, captions.length, title, detail));
    await page.screenshot({ path: `${tmp}/caption-${index + 1}.png` });
  }
  await page.close();
}

/**
 * Plays one scene into a fresh shell and returns what was recorded, on the tape's clock.
 *
 * `carriedPane` is the pane the scene before it ended on, so a scene that does not open with
 * `Pane` keeps showing what was already there rather than starting on nothing.
 */
async function recordScene(
  browser: Browser,
  scene: Scene,
  options: {
    sceneName: string;
    port: number;
    carriedPane?: { name: string };
    storyboard: Storyboard;
    terminal: Dimensions;
    tmp: string;
    ttyd: string;
  },
): Promise<Recording> {
  const { storyboard, tmp, sceneName } = options;
  const rcfile = `${tmp}/${sceneName}.bashrc`;
  await fs.writeFile(rcfile, buildBashrc(storyboard, scene));
  const ttyd = spawn(
    options.ttyd,
    [
      ...['--port', String(options.port), '--interface', '127.0.0.1', '--writable', '--once'],
      ...['-t', 'fontSize=14', '-t', 'fontFamily=DejaVu Sans Mono', '-t', 'lineHeight=1.15'],
      ...['-t', 'cursorBlink=false', '-t', 'disableLeaveAlert=true'],
      ...['-t', 'disableResizeOverlay=true', '-t', `theme=${JSON.stringify(THEME)}`],
      ...['bash', '--rcfile', rcfile, '-i'],
    ],
    { cwd: storyboard.cwd, stdio: 'ignore', env: { ...process.env, HISTFILE: '/dev/null' } },
  );
  const page = await browser.newPage({ viewport: options.terminal });
  try {
    await gotoWhenServerIsUp(page, `http://127.0.0.1:${options.port}/`);
    await page.addStyleTag({
      content: `html, body { background: ${THEME.background}; margin: 0; }
                #terminal-container { box-sizing: border-box; padding: 16px; height: 100vh; }`,
    });
    await page.evaluate(`window.terminalText = ${terminalText}`);
    await page.evaluate(() => globalThis.dispatchEvent(new Event('resize')));
    await waitForTerminalText(page, /❯/);

    const frames: Recording['frames'] = [];
    const panes: Recording['panes'] = options.carriedPane
      ? [{ name: options.carriedPane.name, atMs: 0 }]
      : [];
    // Two clocks: when each step actually happened, and when it should be shown. `onTapeClock`
    // moves the frames from the first onto the second.
    const marks = [{ atMs: 0, showMs: 0 }];
    const cdp = await page.context().newCDPSession(page);
    const start = Date.now();
    const now = () => Date.now() - start;
    cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      const file = `${tmp}/${sceneName}-${String(frames.length).padStart(5, '0')}.png`;
      frames.push({ file, atMs: now() });
      writeFileSync(file, data, 'base64');
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });

    for (const step of scene.steps) {
      const began = now();
      if (step.do === 'type') await page.keyboard.type(step.text, { delay: TYPING_MS });
      else if (step.do === 'press') await page.keyboard.press(step.key);
      else if (step.do === 'sleep') await page.waitForTimeout(step.ms);
      else if (step.do === 'pane') panes.push({ name: step.name, atMs: now() });
      else if (step.do === 'action') await runAction(storyboard, step.name);
      else await waitForTerminalText(page, step.pattern);

      marks.push({ atMs: now(), showMs: marks.at(-1)!.showMs + nominalMs(step, now() - began) });
    }
    await cdp.send('Page.stopScreencast');
    // Off camera: Ctrl-D ends a REPL the scene left open, then the shell, so nothing outlives it.
    for (const _ of [1, 2]) {
      await page.keyboard.press('Control+D');
      await page.waitForTimeout(600);
    }

    return { name: sceneName, ...onTapeClock(marks, frames, panes) };
  } finally {
    await page.close();
    ttyd.kill();
  }
}

/** Runs one `Do <name>`, or says which tape asked for an action nothing declares. */
async function runAction(storyboard: Storyboard, name: string): Promise<void> {
  const declared = storyboard.actions?.[name];
  if (!declared) {
    throw new Error(`${storyboard.tape} says \`Do ${name}\`, but there is no such action`);
  }

  await declared();
}

/** The shell each scene starts in: a plain prompt, and whatever the storyboard adds to it. */
function buildBashrc(storyboard: Storyboard, scene: Scene): string {
  return [
    String.raw`PS1='\[\e[38;2;189;147;249m\]❯\[\e[0m\] '`,
    'set +m',
    ...(storyboard.shellLines?.(scene) ?? []),
    '',
  ].join('\n');
}

// ── compositing ─────────────────────────────────────────────────────────────────────────────

/**
 * One scene as a lossless intermediate: every pane of the workspace, stacked.
 *
 * A pane's track is a concat-demuxer playlist rather than a video, because the terminal was
 * recorded at whatever rate it repainted and a pane of stills changes a handful of times — writing
 * each as "this picture, for this long" is what lets {@link stackFilter} resample them all onto
 * {@link FPS} without any of them being stretched to fit another.
 */
function composeScene(
  ffmpeg: string,
  cwd: string,
  tmp: string,
  frame: MeasuredWorkspace,
  recording: Recording,
  index: number,
): void {
  const { name, frames, panes, durationMs } = recording;
  writeFileSync(`${tmp}/${name}.frames.txt`, buildPlaylist(frames, durationMs));
  writeFileSync(
    `${tmp}/${name}.panes.txt`,
    buildPlaylist(
      panes.map((pane) => ({ file: `${tmp}/pane-${pane.name}.png`, atMs: pane.atMs })),
      durationMs,
    ),
  );
  const track = {
    caption: ['-loop', '1', '-i', `${tmp}/caption-${index + 1}.png`],
    terminal: ['-f', 'concat', '-safe', '0', '-i', `${tmp}/${name}.frames.txt`],
    screenshots: ['-f', 'concat', '-safe', '0', '-i', `${tmp}/${name}.panes.txt`],
  };
  runProgram(ffmpeg, cwd, [
    ...['-y', '-v', 'error'],
    ...panesOfWorkspace(frame).flatMap((pane) => track[pane.kind]),
    ...['-filter_complex', stackFilter(frame, FPS)],
    ...['-t', (durationMs / 1000).toFixed(3), '-c:v', 'ffv1', `${tmp}/${name}.mkv`],
  ]);
}

/**
 * The scenes, end to end, as the GIF that ships.
 *
 * One palette for the whole film — generated from every frame, then applied — and no dithering,
 * because a terminal is flat colour and dithering only gives it a texture to compress. gifsicle
 * takes the last third of the file off afterwards.
 */
function stitchGif(
  programs: { ffmpeg: string; gifsicle: string },
  cwd: string,
  tmp: string,
  recordings: readonly Recording[],
  gif: string,
): void {
  writeFileSync(
    `${tmp}/scenes.txt`,
    recordings.map(({ name }) => `file '${tmp}/${name}.mkv'`).join('\n'),
  );
  runProgram(programs.ffmpeg, cwd, [
    ...['-y', '-v', 'error'],
    ...['-f', 'concat', '-safe', '0', '-i', `${tmp}/scenes.txt`],
    ...[
      '-filter_complex',
      '[0:v]split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none',
    ],
    ...['-loop', '0', `${tmp}/demo.gif`],
  ]);
  runProgram(programs.gifsicle, cwd, ['-O3', '--lossy=20', `${tmp}/demo.gif`, '-o', gif]);
}

/** `file … / duration …` pairs, which is what the concat demuxer reads. */
function buildPlaylist(
  entries: readonly { file: string; atMs: number }[],
  durationMs: number,
): string {
  return (
    entries
      .map(({ file, atMs }, i) => {
        const next = entries[i + 1]?.atMs ?? durationMs;

        return `file '${file}'\nduration ${((next - atMs) / 1000).toFixed(3)}`;
      })
      // The demuxer drops the last entry's duration unless the file is listed one more time.
      .concat(`file '${entries.at(-1)!.file}'`)
      .join('\n')
  );
}

function runProgram(command: string, cwd: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
}

async function waitForTerminalText(page: Page, pattern: RegExp): Promise<void> {
  try {
    await page.waitForFunction(
      ([source, flags]) =>
        new RegExp(source!, flags).test(
          (globalThis as unknown as { terminalText(): string }).terminalText(),
        ),
      [pattern.source, pattern.flags],
      { timeout: TERMINAL_TIMEOUT_MS },
    );
  } catch (cause) {
    // What the terminal did show, because a `Wait` that never resolves is a command that did
    // something else — and the tape cannot say what.
    const shown = await page.evaluate(() =>
      (globalThis as unknown as { terminalText(): string }).terminalText(),
    );

    throw new Error(`the terminal never showed ${pattern}. It showed:\n${shown.trim()}`, { cause });
  }
}

async function gotoWhenServerIsUp(page: Page, url: string): Promise<void> {
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

function buildCaptionHTML(
  dimensions: Dimensions,
  index: number,
  total: number,
  title: string,
  detail: string,
): string {
  const segments = Array.from(
    { length: total },
    (_, i) => `<span class="${i < index ? 'done' : i === index ? 'now' : ''}"></span>`,
  ).join('');
  return `
    <style>
      body { margin: 0; height: ${dimensions.height}px; background: #1e1f29; color: #f8f8f2;
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

/** The terminal's whole buffer as text. Installed into the ttyd page, where `term` is xterm.js. */
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
