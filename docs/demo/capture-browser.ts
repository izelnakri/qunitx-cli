// Renders the right-hand pane of docs/demo.gif: the real pages qunitx serves, in a browser frame,
// plus the caption strip and the intro card. Driven by make-gif.ts, one process per engine:
//
//   node docs/demo/capture-browser.ts <outDir> [--engine=firefox] <shot>...
//
// Each shot reads the demo project as it is on disk, so make-gif.ts writes the buggy or the
// fixed test file before asking for the shots that need it.
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
export const CAPTION = { width: 1160, height: 56 };
const TOOLBAR_HEIGHT = 30;
// The page is laid out at this width and scaled down into the pane, so QUnit's UI keeps its
// desktop layout instead of wrapping at 440px.
const PAGE_SCALE = 0.75;
const DEMO = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(DEMO, '../../cli.ts');

/** The storyboard's captions, in scene order: what a stranger needs to read to follow along. */
export const CAPTIONS: [title: string, detail: string][] = [
  [
    'Write tests in TypeScript',
    'no config, no tsconfig: the DOM and Intl in them are the browser’s own',
  ],
  ['Run them in headless Chrome', 'test files run in parallel, results stream back as TAP'],
  ['--watch', 're-runs on every save, and serves the same page to open yourself'],
  ['Pick what runs', 'list tests by name without a browser, run one by its line'],
  ['Firefox and WebKit too', 'the same suite, any Playwright engine, four reporters'],
  ['--coverage', 'V8 line coverage: a terminal summary, lcov, or this HTML report'],
  ['qunitx repl', 'a prompt that evaluates inside the page: its DOM, its fetch, QUnit'],
];

const SHOTS: Record<string, (browser: Browser, outDir: string) => Promise<void>> = {
  async captions(browser, outDir) {
    const page = await browser.newPage({ viewport: CAPTION });
    for (const [index, [title, detail]] of CAPTIONS.entries()) {
      await page.setContent(captionHTML(index, title, detail));
      await page.screenshot({ path: `${outDir}/caption-${index + 1}.png` });
    }
    await page.close();
  },
  async intro(browser, outDir) {
    const page = await browser.newPage({ viewport: PANE });
    await page.setContent(INTRO_HTML);
    await page.screenshot({ path: `${outDir}/pane-intro.png` });
    await page.close();
  },
  red: (browser, outDir) => shootSuite(browser, `${outDir}/pane-red.png`, ['test/']),
  green: (browser, outDir) => shootSuite(browser, `${outDir}/pane-green.png`, ['test/']),
  filtered: (browser, outDir) =>
    shootSuite(browser, `${outDir}/pane-filtered.png`, ['test/cart-test.ts#17']),
  firefox: (browser, outDir) =>
    shootSuite(browser, `${outDir}/pane-firefox.png`, ['test/', '--browser=firefox'], 'Firefox'),
  async coverage(browser, outDir) {
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
  async repl(browser, outDir) {
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

function captionHTML(index: number, title: string, detail: string): string {
  const segments = CAPTIONS.map(
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
    <div class="text"><span class="step">${index + 1}/${CAPTIONS.length}</span>
      <span class="title">${title}</span><span class="detail">${detail}</span></div>
    <div class="progress">${segments}</div>`;
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
      await SHOTS[shot](browser, outDir);
      console.log(`  ${shot}`);
    }
  } finally {
    await browser.close();
  }
}
