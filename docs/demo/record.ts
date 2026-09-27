import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import type { Browser, Page } from 'playwright-core';
import type { Scene, Step } from './tape.ts';
import type { Tool } from './tools.ts';

// Everything Playwright does: draw the caption strip, and play a scene into a real shell while a
// CDP screencast records it. What comes back is frames with timestamps and the moments the pane
// changed — pictures and a timeline, with nothing yet decided about how they are stitched.

/** How long a `Wait` shows for, however long it actually took. */
export const WAIT_HOLD_MS = 1_200;
/** Keystroke to keystroke, so typing reads at a human speed rather than appearing at once. */
export const TYPING_MS = 35;

/** One scene, recorded: its frames, when the pane changed, and how long it runs for. */
export interface Recording {
  name: string;
  frames: { file: string; atMs: number }[];
  panes: { shot: string; atMs: number }[];
  durationMs: number;
}

/** The terminal's colours, and the palette the caption strip is chosen around. Dracula. */
export const THEME = {
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

/** What a scene needs from the studio to be played. */
export interface Stage {
  browser: Browser;
  ttyd: Tool;
  /** Written into each scene's bashrc, so `qunitx` means this checkout and `bat` is themed. */
  bashrc: (scene: Scene) => string;
  terminal: { width: number; height: number };
  work: string;
  cwd: string;
  /** Saves the corrected test file, which is what `Fix` means. */
  fix: () => Promise<void>;
}

/**
 * Plays one scene and returns what was recorded, timed from zero.
 *
 * `carried` is the pane the scene before it ended on, so a scene that does not open with `Pane`
 * keeps showing what was already there rather than starting on nothing.
 */
export async function playScene(
  stage: Stage,
  name: string,
  scene: Scene,
  carried: { shot: string } | undefined,
  port: number,
): Promise<Recording> {
  const rcfile = `${stage.work}/${name}.bashrc`;
  await fs.writeFile(rcfile, stage.bashrc(scene));
  const ttyd = spawn(
    stage.ttyd[0]!,
    [
      ...['--port', String(port), '--interface', '127.0.0.1', '--writable', '--once'],
      ...['-t', 'fontSize=14', '-t', 'fontFamily=DejaVu Sans Mono', '-t', 'lineHeight=1.15'],
      ...['-t', 'cursorBlink=false', '-t', 'disableLeaveAlert=true'],
      ...['-t', 'disableResizeOverlay=true', '-t', `theme=${JSON.stringify(THEME)}`],
      ...['bash', '--rcfile', rcfile, '-i'],
    ],
    { cwd: stage.cwd, stdio: 'ignore', env: { ...process.env, HISTFILE: '/dev/null' } },
  );
  const page = await stage.browser.newPage({ viewport: stage.terminal });
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
    // Two clocks: when each step actually happened, and when it should be shown. `retime` below
    // moves the frames from the first onto the second.
    const marks = [{ atMs: 0, showMs: 0 }];
    const cdp = await page.context().newCDPSession(page);
    const start = Date.now();
    const now = () => Date.now() - start;
    cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      const file = `${stage.work}/${name}-${String(frames.length).padStart(5, '0')}.png`;
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
      else if (step.do === 'pane') panes.push({ shot: step.shot, atMs: now() });
      else if (step.do === 'fix') await stage.fix();
      else await waitForTerminal(page, step.pattern);

      marks.push({
        atMs: now(),
        showMs: marks.at(-1)!.showMs + nominalMs(step, now() - began),
      });
    }
    await cdp.send('Page.stopScreencast');
    const recording = { name, frames, panes, durationMs: now() };
    // Off camera: Ctrl-D ends a REPL the scene left open, then the shell, so nothing outlives it.
    for (const _ of [1, 2]) {
      await page.keyboard.press('Control+D');
      await page.waitForTimeout(600);
    }

    return retime(recording, marks);
  } finally {
    await page.close();
    ttyd.kill();
  }
}

/**
 * How long a step SHOULD take, which is what the tape says rather than what the machine managed.
 *
 * Everything the recorder does takes longer on a busy machine, and two of them take much longer: a
 * `Wait` ends when a command finishes, and `Type` pays a round trip per keystroke on top of its
 * delay. Recorded at 2x load this demo ran 84s instead of 64s; recorded while the machine was
 * still settling, 78s. Nothing was wrong with any of them — they are recordings of real commands,
 * and the commands were slow.
 *
 * So the pictures come from the recording and the clock comes from here. A `Wait` always shows for
 * {@link WAIT_HOLD_MS}, whether it waited for a tenth of that or ten times it, because what is on
 * screen while a command runs is a command running.
 */
export function nominalMs(step: Step, tookMs: number): number {
  if (step.do === 'sleep') return step.ms;
  if (step.do === 'type') return step.text.length * TYPING_MS;
  if (step.do === 'wait') return WAIT_HOLD_MS;

  // A keypress, a pane switch, saving a file: nothing to watch, and nothing to stretch.
  return Math.min(tookMs, 100);
}

/**
 * Puts the frames on the tape's clock. Exported for its test: it is the one part of recording that
 * is a pure function of a timeline, and the one that decides whether two machines agree.
 *
 * `marks` pairs each step boundary's real timestamp with the one it should be shown at, so this
 * only has to place what happened in between — proportionally, since a step that took four seconds
 * to type and should take two has frames all the way through it. Frames that land on the same
 * shown millisecond collapse to the first, which is the one the screen actually held.
 */
export function retime(
  recording: Recording,
  marks: readonly { atMs: number; showMs: number }[],
): Recording {
  const shown = (atMs: number): number => {
    const next = marks.findIndex((mark) => mark.atMs > atMs);
    if (next <= 0) return next === 0 ? 0 : marks.at(-1)!.showMs;

    const from = marks[next - 1]!;
    const to = marks[next]!;
    const span = to.atMs - from.atMs;
    const part = span === 0 ? 1 : (atMs - from.atMs) / span;

    return Math.round(from.showMs + (to.showMs - from.showMs) * part);
  };
  const seen = new Set<number>();

  return {
    name: recording.name,
    frames: recording.frames
      .map((frame) => ({ ...frame, atMs: shown(frame.atMs) }))
      .filter(({ atMs }) => !seen.has(atMs) && seen.add(atMs) !== undefined),
    panes: recording.panes.map((pane) => ({ ...pane, atMs: shown(pane.atMs) })),
    durationMs: marks.at(-1)!.showMs,
  };
}

/** The strip along the top: one PNG per scene, from the tape's own words. */
export async function captionStrip(
  browser: Browser,
  captions: readonly [title: string, detail: string][],
  size: { width: number; height: number },
  work: string,
): Promise<void> {
  const page = await browser.newPage({ viewport: size });
  for (const [index, [title, detail]] of captions.entries()) {
    await page.setContent(captionHTML(index, captions.length, title, detail, size.height));
    await page.screenshot({ path: `${work}/caption-${index + 1}.png` });
  }
  await page.close();
}

function captionHTML(
  index: number,
  total: number,
  title: string,
  detail: string,
  height: number,
): string {
  const segments = Array.from(
    { length: total },
    (_, i) => `<span class="${i < index ? 'done' : i === index ? 'now' : ''}"></span>`,
  ).join('');
  return `
    <style>
      body { margin: 0; height: ${height}px; background: #1e1f29; color: #f8f8f2;
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

// Generous, and it can afford to be now: a slow machine no longer makes a slower GIF, so the only
// thing waiting longer costs is the recording taking longer. At 30s a busy laptop gave up partway
// through with a TimeoutError instead of finishing.
const TERMINAL_TIMEOUT_MS = 90_000;

async function waitForTerminal(page: Page, pattern: RegExp): Promise<void> {
  await page.waitForFunction(
    ([source, flags]) =>
      new RegExp(source!, flags).test(
        (globalThis as unknown as { terminalText(): string }).terminalText(),
      ),
    [pattern.source, pattern.flags],
    { timeout: TERMINAL_TIMEOUT_MS },
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
