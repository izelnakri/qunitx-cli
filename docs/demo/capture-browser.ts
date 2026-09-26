// The right-hand pane of docs/demo.gif: the real pages qunitx serves, in a browser frame. Driven
// by make-gif.ts, one process per engine:
//
//   node docs/demo/capture-browser.ts <outDir> [--engine=firefox] <shot>...
//
// A shot reads the demo project as it is on disk, and says in `needs` whether it wants the bug
// there or gone — make-gif.ts reads that and writes the file before asking. Nothing here knows
// the storyboard; `demo.tape` names these by the panes it switches to.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import * as Chrome from '../../lib/chrome/index.ts';

export const PANE = { width: 440, height: 600 };
const TOOLBAR_HEIGHT = 30;
// The page is laid out at this width and scaled down into the pane, so QUnit's UI keeps its
// desktop layout instead of wrapping at 440px.
const PAGE_SCALE = 0.75;
const DEMO = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(DEMO, '../../cli.ts');

/** One pane of the demo: what it needs on disk, what it renders with, and what it leaves behind. */
export interface Shot {
  /** Whether the demo project's test file must still have the bug in it, or not. */
  needs: 'broken' | 'fixed';
  /** The engine that renders it. Chromium unless it is the shot about Firefox. */
  engine?: 'firefox';
  /** The pane names it writes, where one shot makes several. Defaults to its own name. */
  produces?: string[];
  take(browser: Browser, outDir: string): Promise<void>;
}

export const SHOTS: Record<string, Shot> = {
  intro: {
    needs: 'fixed',
    async take(browser, outDir) {
      const page = await browser.newPage({ viewport: PANE });
      await page.setContent(INTRO_HTML);
      await page.screenshot({ path: `${outDir}/pane-intro.png` });
      await page.close();
    },
  },
  // The one shot taken with the bug still on disk: the failing run the demo opens on.
  red: {
    needs: 'broken',
    take: (browser, outDir) => shootSuite(browser, `${outDir}/pane-red.png`, ['test/']),
  },
  green: {
    needs: 'fixed',
    take: (browser, outDir) => shootSuite(browser, `${outDir}/pane-green.png`, ['test/']),
  },
  filtered: {
    needs: 'fixed',
    take: (browser, outDir) =>
      shootSuite(browser, `${outDir}/pane-filtered.png`, ['test/cart-test.ts#17']),
  },
  firefox: {
    needs: 'fixed',
    engine: 'firefox',
    take: (browser, outDir) =>
      shootSuite(browser, `${outDir}/pane-firefox.png`, ['test/', '--browser=firefox'], 'Firefox'),
  },
  coverage: {
    needs: 'fixed',
    async take(browser, outDir) {
      const output = path.join(outDir, 'coverage-run');
      await run([CLI, 'test/', '--coverage=html', `--output=${output}`, '--reporter=dot']);
      const page = await browser.newPage({ viewport: pageViewport() });
      await page.goto(`file://${output}/coverage/index.html`);
      await frame(
        browser,
        await base64(page),
        `${outDir}/pane-coverage.png`,
        'tmp/coverage/index.html',
        'Chrome',
      );
      await page.close();
    },
  },
  // Three panes from one prompt: the same session, photographed as it is typed into.
  repl: {
    needs: 'fixed',
    produces: ['repl-1', 'repl-2', 'repl-3'],
    async take(browser, outDir) {
      // The REPL's own page: `<url>/repl` redirects to DevTools, whose `ws=` is a CDP socket on the
      // very page the prompt drives, so these are its pixels, not a replica.
      const repl = spawn(process.execPath, [CLI, 'repl', 'src/cart.ts', '--port=1234'], {
        cwd: DEMO,
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      try {
        await outputMatching(repl, /type `\.help`/);
        const redirect = await fetch('http://localhost:1234/repl', { redirect: 'manual' });
        const cdp = await CDP.connect(
          new URL(redirect.headers.get('location')!).searchParams.get('ws')!,
        );
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          ...pageViewport(),
          deviceScaleFactor: 1,
          mobile: false,
        });
        const shoot = async (name: string) => {
          const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
          await frame(browser, data, `${outDir}/pane-${name}.png`, 'localhost:1234', 'Chrome');
        };
        const say = async (line: string, pattern: RegExp) => {
          repl.stdin!.write(`${line}\n`);
          await outputMatching(repl, pattern);
        };

        await shoot('repl-1');
        await say("const cart = new Cart().add({ name: 'Coffee', price: 4, qty: 3 })", /undefined/);
        await say('document.body.append(cart.render())', /undefined/);
        await shoot('repl-2');
        await say("test('adds up', (assert) => assert.equal(cart.total, 12))", /ok 1/);
        await shoot('repl-3');
        cdp.close();
        repl.stdin!.end('.exit\n');
      } finally {
        await stop(repl);
      }
    },
  },
};

/** Serves the suite the way `--watch` does and screenshots the page once QUnit is done with it. */
async function shootSuite(
  browser: Browser,
  file: string,
  args: string[],
  engine = 'Chrome',
): Promise<void> {
  const server = spawn(process.execPath, [CLI, ...args, '--watch', '--port=1234'], {
    cwd: DEMO,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    const [url] = (await outputMatching(server, /browse the tests on (\S+)/)).slice(1);
    const page = await browser.newPage({ viewport: pageViewport() });
    await page.goto(url);
    await page.waitForSelector('#qunit-banner.qunit-pass, #qunit-banner.qunit-fail');
    await frame(browser, await base64(page), file, new URL(url).host, engine);
    await page.close();
  } finally {
    await stop(server);
  }
}

/** Screenshots the page and sets it into the pane under a browser toolbar naming URL and engine. */
async function frame(
  browser: Browser,
  shot: string,
  file: string,
  url: string,
  engine: string,
): Promise<void> {
  const pane = await browser.newPage({ viewport: PANE });
  await pane.setContent(`
    <style>
      body { margin: 0; font: 12px system-ui, sans-serif; overflow: hidden; background: #fff; }
      .bar { height: ${TOOLBAR_HEIGHT}px; display: flex; align-items: center; gap: 6px; padding: 0 10px;
             background: #e8e8ec; border-bottom: 1px solid #cfcfd6; box-sizing: border-box; }
      .dot { width: 10px; height: 10px; border-radius: 50%; background: #c4c4cc; }
      .url { flex: 1; margin: 0 6px; padding: 3px 10px; border-radius: 10px; background: #fff; color: #444; }
      .engine { color: #666; }
      img { display: block; width: ${PANE.width}px; }
    </style>
    <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>
      <span class="url">${url}</span><span class="engine">${engine}</span></div>
    <img src="data:image/png;base64,${shot}">`);
  await pane.screenshot({ path: file });
  await pane.close();
}

async function base64(page: Page): Promise<string> {
  return (await page.screenshot()).toString('base64');
}

/** Just enough of the DevTools protocol to drive one page over its WebSocket. */
const CDP = {
  async connect(address: string) {
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
  },
};

function pageViewport() {
  return {
    width: Math.round(PANE.width / PAGE_SCALE),
    height: Math.round((PANE.height - TOOLBAR_HEIGHT) / PAGE_SCALE),
  };
}

/** Resolves with the match once the child's stdout, read from the start, matches `pattern`. */
function outputMatching(child: ChildProcess, pattern: RegExp): Promise<RegExpMatchArray> {
  const state = child as ChildProcess & { seen?: string };
  return new Promise((resolve, reject) => {
    const check = () => {
      const match = (state.seen ?? '').match(pattern);
      if (match) {
        // Consumed, so the next wait looks for its own line and not this one again.
        state.seen = state.seen!.slice(match.index! + match[0].length);
        child.stdout!.off('data', onData);
        child.off('exit', onExit);
        resolve(match);
      }
    };
    const onData = (chunk: Buffer) => {
      state.seen = (state.seen ?? '') + chunk.toString();
      check();
    };
    const onExit = () => reject(new Error(`exited before printing ${pattern}:\n${state.seen}`));
    child.stdout!.on('data', onData);
    child.once('exit', onExit);
    check();
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGINT');
  await exited;
}

async function run(args: string[]): Promise<void> {
  const child = spawn(process.execPath, args, { cwd: DEMO, stdio: 'ignore' });
  await once(child, 'exit');
}

const INTRO_HTML = `
  <style>
    body { margin: 0; height: ${PANE.height}px; box-sizing: border-box; padding: 44px 36px;
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

const [outDir, ...rest] = process.argv.slice(2);
if (import.meta.main && outDir) {
  const engine = rest.find((arg) => arg.startsWith('--engine='))?.slice('--engine='.length);
  const shots = rest.filter((arg) => !arg.startsWith('--'));
  await fs.mkdir(outDir, { recursive: true });
  const browser =
    engine === 'firefox'
      ? await firefox.launch()
      : await chromium.launch({ executablePath: (await Chrome.find()) ?? undefined });
  try {
    for (const shot of shots) {
      await SHOTS[shot]!.take(browser, outDir);
      console.log(`  ${shot}`);
    }
  } finally {
    await browser.close();
  }
}
