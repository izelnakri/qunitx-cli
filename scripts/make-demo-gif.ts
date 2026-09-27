// docs/demo.gif: `make demo`, or `node scripts/make-demo-gif.ts`.
//
// docs/demo/demo.tape is the storyboard — the captions, the keys, and the `Pane` and `Do` names.
// This file is the rest of the demo: what those names mean, and the recipes that photograph the
// pages qunitx really serves. `demogod` (examples/demogod) turns the two into the GIF.
//
// The declaration is the first screen. Everything under it is one pane, or one of the processes a
// pane drives.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Demo, findProgram, runInFHS } from 'demogod';
import * as Chrome from '../lib/chrome/index.ts';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { CapturePane, Dimensions, Pane, Scene } from 'demogod';
import type { Page } from 'playwright-core';

/** The little project everything in the demo runs against: a shopping cart, five tests, one bug. */
const DEMO_PROJECT = path.join(import.meta.dirname!, '../docs/demo');
const CART_TEST_FILE = path.join(DEMO_PROJECT, 'test/cart-test.ts');
const QUNITX_COMMAND = [process.execPath, path.join(import.meta.dirname!, '../cli.ts')];
/** Height of the fake browser toolbar drawn above every page in the browser pane. */
const TOOLBAR_HEIGHT = 30;
/** The page is laid out this much wider than the pane and scaled down into it, so QUnit's UI keeps
 * its desktop layout instead of wrapping at pane width. */
const PAGE_SCALE = 0.75;
/** The bug: the test forgets Coffee's quantity, so three coffees are billed as one. */
const PASSING_TEST_SOURCE = await fs.readFile(CART_TEST_FILE, 'utf8');
const FAILING_TEST_SOURCE = PASSING_TEST_SOURCE.replace(
  "{ name: 'Coffee', price: 4, qty: 3 }",
  "{ name: 'Coffee', price: 4 }",
);
if (FAILING_TEST_SOURCE === PASSING_TEST_SOURCE) {
  throw new Error(`${CART_TEST_FILE} no longer has the line the demo breaks`);
}
// However this ends — a throw, a Ctrl-C — the project is left as it was found.
process.on('exit', () => writeFileSync(CART_TEST_FILE, PASSING_TEST_SOURCE));
process.on('SIGINT', () => process.exit(130));

await using demo = await Demo.open({
  tape: path.join(DEMO_PROJECT, 'demo.tape'),
  gif: path.join(import.meta.dirname!, '../docs/demo.gif'),
  cwd: DEMO_PROJECT,
  chromePath: (await Chrome.find()) ?? undefined,

  /** The frame: a caption strip over the terminal and the browser pane, side by side. */
  workspace: {
    column: [
      { caption: { height: 56 } },
      {
        row: [
          { terminal: { width: 720, height: 600 } },
          { screenshots: { width: 440, height: 600 } },
        ],
      },
    ],
  },

  /** Every `Pane <name>` the tape switches to, and the page it shows. */
  panes: {
    intro: introCard(),
    red: withFailingTest(suitePage('test/')),
    green: suitePage('test/'),
    filtered: suitePage('test/cart-test.ts#17'),
    firefox: suitePage('test/', '--browser=firefox'),
    coverage: coverageReport(),
    // One prompt, photographed three times: each pane is the page after these lines are typed.
    ...replSession({
      'repl-1': [],
      'repl-2': [
        "const cart = new Cart().add({ name: 'Coffee', price: 4, qty: 3 })",
        'document.body.append(cart.render())',
      ],
      'repl-3': ["test('adds up', (assert) => assert.equal(cart.total, 12))"],
    }),
  },

  /** Every `Do <name>`, which happens off camera between two keystrokes. */
  actions: {
    break: () => fs.writeFile(CART_TEST_FILE, FAILING_TEST_SOURCE),
    fix: () => fs.writeFile(CART_TEST_FILE, PASSING_TEST_SOURCE),
  },

  /** On top of a bare prompt, the two commands the tape types. */
  shellLines: (scene) => [
    `alias bat='${findProgram('bat')} --paging=never --style=numbers,header,grid'`,
    `alias qunitx='${qunitxFor(scene).join(' ')}'`,
  ],
});

console.log(`==> ${demo.scenes.length} scenes from demo.tape`);
console.log('==> Photographing the panes');
await demo.capturePanes();

console.log('==> Recording the terminal');
await demo.recordScenes();

console.log('==> Compositing');
const { kb, seconds } = await demo.saveGif();
console.log(`==> docs/demo.gif: ${kb} KB, ${seconds.toFixed(1)}s`);

/** The same pane, but photographed while the cart test is the failing one. */
function withFailingTest(capture: CapturePane): CapturePane {
  return async (pane) => {
    await fs.writeFile(CART_TEST_FILE, FAILING_TEST_SOURCE);
    try {
      await capture(pane);
    } finally {
      await fs.writeFile(CART_TEST_FILE, PASSING_TEST_SOURCE);
    }
  };
}

/**
 * What `qunitx` means in this scene's shell: this checkout's CLI, under an FHS wrapper in the
 * scene that asks for Firefox, whose Playwright build is not a NixOS binary.
 */
function qunitxFor(scene: Scene): string[] {
  const typed = scene.steps.map((step) => (step.do === 'type' ? step.text : '')).join('\n');

  return typed.includes('--browser=firefox') ? runInFHS(QUNITX_COMMAND) : QUNITX_COMMAND;
}

// ── the panes ───────────────────────────────────────────────────────────────────────────────

/** The title card the demo opens on: what qunitx is, before anything has run. */
function introCard(): CapturePane {
  return async (pane) => {
    const page = await (await pane.browser()).newPage({ viewport: pane.dimensions });
    await page.setContent(buildIntroHTML(pane.dimensions));
    await page.screenshot({ path: pane.file });
    await page.close();
  };
}

/**
 * The page a run serves, once QUnit has finished with it.
 *
 * The arguments are a `qunitx` command line, so `suitePage('test/', '--browser=firefox')` is
 * photographed by Firefox — the pane shows that engine's own pixels, and says so on its toolbar.
 */
function suitePage(...args: string[]): CapturePane {
  const usesFirefox = args.includes('--browser=firefox');

  return async (pane) => {
    const server = spawnQunitx([...args, '--watch', '--port=1234'], {
      cwd: pane.cwd,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      const [, url] = await readOutput(server).match(/browse the tests on (\S+)/);
      const browser = await pane.browser(usesFirefox ? 'firefox' : 'chromium');
      const page = await browser.newPage({ viewport: pageViewport(pane.dimensions) });
      await page.goto(url!);
      await page.waitForSelector('#qunit-banner.qunit-pass, #qunit-banner.qunit-fail');
      const engine = usesFirefox ? 'Firefox' : 'Chrome';
      await writeBrowserFrame(pane, await takeScreenshot(page), new URL(url!).host, engine);
      await page.close();
    } finally {
      await stopProcess(server);
    }
  };
}

/** `--coverage=html`, opened from disk the way anyone would open it after a run. */
function coverageReport(): CapturePane {
  return async (pane) => {
    const reportDirectory = path.join(pane.tmp, 'coverage-run');
    const run = spawnQunitx(['test/', '--coverage=html', `--output=${reportDirectory}`], {
      cwd: pane.cwd,
      stdio: 'ignore',
    });
    await once(run, 'exit');
    const page = await (await pane.browser()).newPage({ viewport: pageViewport(pane.dimensions) });
    await page.goto(`file://${reportDirectory}/coverage/index.html`);
    await writeBrowserFrame(pane, await takeScreenshot(page), 'tmp/coverage/index.html', 'Chrome');
    await page.close();
  };
}

/**
 * One `qunitx repl` session, photographed more than once as it is typed into.
 *
 * Every key is a pane name and every value the lines typed into the prompt before that pane is
 * taken, so the panes come out of one continuous session rather than several replicas of it. The
 * pictures are the REPL's own page: `<url>/repl` redirects to DevTools, whose `ws=` is a CDP socket
 * on the very page the prompt drives.
 */
function replSession(linesBeforeEachPane: Record<string, string[]>): Record<string, CapturePane> {
  const lastPane = Object.keys(linesBeforeEachPane).at(-1);
  let session: Promise<ReplSession> | null = null;

  return Object.fromEntries(
    Object.entries(linesBeforeEachPane).map(([name, lines]): [string, CapturePane] => [
      name,
      async (pane) => {
        const repl = await (session ??= startReplSession(pane));
        for (const line of lines) await repl.type(line);
        await repl.capturePane(pane);
        if (name === lastPane) await repl.close();
      },
    ]),
  );
}

// ── the browser frame ───────────────────────────────────────────────────────────────────────

/** Sets a screenshot into the pane under a browser toolbar naming the URL and the engine. */
async function writeBrowserFrame(
  pane: Pane,
  screenshot: string,
  url: string,
  engine: string,
): Promise<void> {
  const framePage = await (await pane.browser()).newPage({ viewport: pane.dimensions });
  await framePage.setContent(`
    <style>
      body { margin: 0; font: 12px system-ui, sans-serif; overflow: hidden; background: #fff; }
      .bar { height: ${TOOLBAR_HEIGHT}px; display: flex; align-items: center; gap: 6px; padding: 0 10px;
             background: #e8e8ec; border-bottom: 1px solid #cfcfd6; box-sizing: border-box; }
      .dot { width: 10px; height: 10px; border-radius: 50%; background: #c4c4cc; }
      .url { flex: 1; margin: 0 6px; padding: 3px 10px; border-radius: 10px; background: #fff; color: #444; }
      .engine { color: #666; }
      img { display: block; width: ${pane.dimensions.width}px; }
    </style>
    <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>
      <span class="url">${url}</span><span class="engine">${engine}</span></div>
    <img src="data:image/png;base64,${screenshot}">`);
  await framePage.screenshot({ path: pane.file });
  await framePage.close();
}

/** The viewport a page is laid out at to fill the pane under the toolbar once scaled down. */
function pageViewport(paneSize: Dimensions): Dimensions {
  return {
    width: Math.round(paneSize.width / PAGE_SCALE),
    height: Math.round((paneSize.height - TOOLBAR_HEIGHT) / PAGE_SCALE),
  };
}

async function takeScreenshot(page: Page): Promise<string> {
  return (await page.screenshot()).toString('base64');
}

// ── the REPL ────────────────────────────────────────────────────────────────────────────────

interface ReplSession {
  /** Types a line and waits for its result. */
  type(line: string): Promise<void>;
  /** Photographs the page as it stands into `pane.file`. */
  capturePane(pane: Pane): Promise<void>;
  close(): Promise<void>;
}

async function startReplSession(pane: Pane): Promise<ReplSession> {
  const repl = spawnQunitx(['repl', 'src/cart.ts', '--port=1234'], {
    cwd: pane.cwd,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const printed = readOutput(repl);
  await printed.match(/type `\.help`/);
  const redirect = await fetch('http://localhost:1234/repl', { redirect: 'manual' });
  const cdp = await connectToCDP(
    new URL(redirect.headers.get('location')!).searchParams.get('ws')!,
  );
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    ...pageViewport(pane.dimensions),
    deviceScaleFactor: 1,
    mobile: false,
  });

  return {
    async type(line) {
      repl.stdin!.write(`${line}\n`);
      // Its stdout is a pipe, not a terminal, so the REPL prints no prompt: one line in, one line
      // of result out, and that line landing is the expression having finished.
      await printed.nextLine();
    },
    async capturePane(into) {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      await writeBrowserFrame(into, data, 'localhost:1234', 'Chrome');
    },
    async close() {
      cdp.close();
      repl.stdin!.end('.exit\n');
      await stopProcess(repl);
    },
  };
}

/** Just enough of the DevTools protocol to drive one page over its WebSocket. */
async function connectToCDP(address: string): Promise<{
  send(method: string, params?: object): Promise<Record<string, string>>;
  close(): void;
}> {
  const socket = new WebSocket(`ws://${address}`);
  const pending = new Map<number, (result: Record<string, string>) => void>();
  let id = 0;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    pending.get(message.id)?.(message.result);
  });
  await once(socket, 'open');

  return {
    send(method: string, params: object = {}): Promise<Record<string, string>> {
      return new Promise((resolve) => {
        pending.set(++id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => socket.close(),
  };
}

// ── the processes ───────────────────────────────────────────────────────────────────────────

/**
 * `qunitx …` as this checkout's CLI, under an FHS wrapper when the run will launch Playwright's
 * Firefox — which is not a NixOS binary, and is a child of this child.
 */
function spawnQunitx(args: readonly string[], options: SpawnOptions): ChildProcess {
  const argv = [...QUNITX_COMMAND, ...args];
  const [command, ...rest] = args.includes('--browser=firefox') ? runInFHS(argv) : argv;

  return spawn(command!, rest, options);
}

/** A child's stdout, read from the start, as two things to wait for. */
function readOutput(child: ChildProcess): {
  match(pattern: RegExp): Promise<RegExpMatchArray>;
  nextLine(): Promise<void>;
} {
  let seen = '';
  const waiting = new Set<() => void>();
  const lines = () => seen.split('\n').length;
  child.stdout!.on('data', (chunk: Buffer) => {
    seen += chunk.toString();
    for (const check of [...waiting]) check();
  });
  const when = (ready: () => boolean) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (ready()) {
          waiting.delete(check);
          resolve();
        } else if (child.exitCode !== null) {
          waiting.delete(check);
          reject(new Error(`exited before printing what the pane needed:\n${seen}`));
        }
      };
      waiting.add(check);
      child.once('exit', check);
      check();
    });

  return {
    match: (pattern) => when(() => pattern.test(seen)).then(() => seen.match(pattern)!),
    nextLine: () => {
      const had = lines();

      return when(() => lines() > had);
    },
  };
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGINT');
  await exited;
}

function buildIntroHTML(dimensions: Dimensions): string {
  return `
  <style>
    body { margin: 0; height: ${dimensions.height}px; box-sizing: border-box; padding: 44px 36px;
           font: 16px/1.5 system-ui, sans-serif; color: #1c1c28; background: #fafafc; }
    h1 { margin: 0; font-size: 40px; letter-spacing: -1px; }
    .tagline { margin: 6px 0 28px; font-size: 18px; color: #4a4a5a; }
    ul { list-style: none; padding: 0; margin: 0 0 30px; }
    li { margin: 9px 0; padding-left: 28px; position: relative; }
    li::before { content: '✓'; position: absolute; left: 0; color: #2a9d5c; font-weight: 700; }
    pre { margin: 0; padding: 14px 16px; border-radius: 8px; background: #282a36; color: #f8f8f2;
          font: 13px/1.7 ui-monospace, monospace; }
    .more { margin-top: 10px; font-size: 13px; color: #6a6a7a; }
    .dim { color: #6272a4; }
  </style>
  <h1>qunitx-cli</h1>
  <div class="tagline">Your JavaScript and TypeScript tests, in a real browser, from the terminal.</div>
  <ul>
    <li>Headless Chrome, Firefox or WebKit</li>
    <li>TypeScript and JSX with zero config</li>
    <li>Watch mode, name filters, line targets</li>
    <li>Coverage, JUnit, four reporters</li>
    <li>A REPL that runs inside the page</li>
  </ul>
  <pre><span class="dim">$</span> npm install --save-dev qunitx-cli
<span class="dim">$</span> npx qunitx test/</pre>
  <div class="more">or the standalone binary: no Node needed</div>`;
}
