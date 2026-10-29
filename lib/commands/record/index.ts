import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { processConsole, type Console } from '../../console.ts';
import { Failure } from '../../result/index.ts';
import { Task } from '../../task/index.ts';
import { blue, cyan, green, magenta, red, yellow } from '../../utils/color.ts';
import {
  DEFAULT_SIZE,
  InvalidRecordOption,
  findPRCommentSettingsProblem,
} from '../../record/options.ts';
import type { RecordOptions, RecordResult } from '../../record/index.ts';
import * as Config from '../../record/config.ts';
import { InvalidRecordArgument, parse, type RecordRequest } from './parse.ts';
import * as StatusLine from './status-line.ts';
import pkg from '../../../package.json' with { type: 'json' };

// A snapshot's line in the color of what happened to it, so a run is read at a glance: green for
// a new baseline, red for a change waiting for review, yellow for a change accepted, and the
// terminal's own color for one that held.
const STATUS_COLORS: Record<string, (text: string) => string> = {
  new: green,
  changed: red,
  updated: yellow,
  unchanged: (text) => text,
};

// `qunitx record`. Its flags are its own rather than the test runner's: `-w`, `-h`, `-f` and `-o`
// mean width, height, format and output here, which is what anyone recording a page reaches for.

/**
 * Runs `qunitx record`: records the inputs, writes the files, and lists them.
 *
 * ```ts
 * import * as Record from './index.ts';
 *
 * // Defined, not invoked: launches a browser and writes files.
 * async function recordCommand(): Promise<number> {
 *   return await Record.run(['https://example.com', '-f', 'png']); // 0 recorded · 1 failed · 2 bad args
 * }
 * ```
 *
 * @returns the process exit code.
 */
export async function run(
  argv: string[] = process.argv.slice(3),
  out: Console = processConsole,
  cwd: string = process.cwd(),
): Promise<number> {
  const parsedRecordRequest = parse(argv);
  if (Failure.is(parsedRecordRequest)) {
    out.error(`${parsedRecordRequest.message}\n\n${usage()}`);
    return 2;
  } else if (parsedRecordRequest.help) {
    out.log(usage());
    return 0;
  }
  const config = await Config.read(cwd);
  if (Failure.is(config)) {
    out.error(`${config.message}\n`);
    return 2;
  }
  // The command line wins, setting by setting, and `pdf` field by field; inputs typed replace the
  // configured inputs outright.
  const recordRequest: RecordRequest = {
    help: false,
    sources: parsedRecordRequest.sources.length ? parsedRecordRequest.sources : config.inputs,
    options: {
      ...config.options,
      ...parsedRecordRequest.options,
      pdf: { ...config.options.pdf, ...parsedRecordRequest.options.pdf },
    },
    cssFile: parsedRecordRequest.cssFile,
    pdfHeaderFile: parsedRecordRequest.pdfHeaderFile,
    pdfFooterFile: parsedRecordRequest.pdfFooterFile,
  };
  if (recordRequest.sources.length === 0) {
    out.error(`qunitx record needs at least one URL, page or script.\n\n${usage()}`);
    return 2;
  }

  const options = await readCSSAndPDFHeaderAndFooterFiles(recordRequest, cwd).result();
  if (Failure.is(options)) {
    out.error(`${options.message}\n\n${usage()}`);
    return 2;
  }
  // Settings that only work together, checked once the command line and package.json are merged.
  const comment = findPRCommentSettingsProblem(options);
  if (comment) {
    out.error(`${InvalidRecordOption(comment).message}\n\n${usage()}`);
    return 2;
  }
  // Loaded once the arguments are known good: it is the browser stack, which help and a typo
  // do not need.
  const { record } = await import('../../record/index.ts');
  // A recording can take a minute: a terminal is shown what it is doing meanwhile, on stderr, and
  // the line is gone before the files are listed.
  const hideStatusLine =
    out === processConsole && process.stderr.isTTY ? StatusLine.show(process.stderr) : () => {};
  return await Task(() =>
    record(recordRequest.sources, { ...options, cwd }).finally(hideStatusLine),
  )
    .map(async (result) => {
      // Shown relative to where the command ran, compared with symlinks resolved: on macOS the temp
      // directory is `/var/…` to whoever parsedRecordRequest it and `/private/var/…` to `process.cwd()`. Only
      // directories are resolved, each once: a run's files are in one or two of them.
      const realDirectories = new Map<string, Promise<string>>();
      const realDirectory = (directory: string) => {
        const real = realDirectories.get(directory) ?? realpath(directory).catch(() => directory);
        realDirectories.set(directory, real);
        return real;
      };
      const root = await realDirectory(cwd);
      const displayPath = async (file: string) =>
        path.relative(
          root,
          path.join(await realDirectory(path.dirname(file)), path.basename(file)),
        );
      for (const file of result.files) {
        const line = await describeOutputFileDetails(file, displayPath);
        out.log(`${file.comparison ? STATUS_COLORS[file.comparison.status](line) : line}\n`);
      }
      // The files to open next, in cyan.
      if (result.reportPath)
        out.log(`${cyan(`${await displayPath(result.reportPath)}  report`)}\n`);
      if (result.reportPdfPath) {
        out.log(`${cyan(`${await displayPath(result.reportPdfPath)}  report`)}\n`);
      }
      if (result.commentPath) {
        out.log(`${cyan(`${await displayPath(result.commentPath)}  comment`)}\n`);
      }
      for (const script of result.failedScripts) {
        out.error(`# ${await displayPath(script.path)} exited ${script.exitCode}\n`);
      }
      if (result.changedSnapshots.length) {
        const count = result.changedSnapshots.length;
        out.error(
          `# ${count} snapshot${count === 1 ? '' : 's'} changed: see the .diff.png beside each, then run again with --update to accept\n`,
        );
      }
      return result.ok ? 0 : 1;
    })
    .recover((error) => {
      out.error(`${Failure.is(error) ? error.message : Failure.format(error)}\n`);
      return 1;
    });
}

// The options with the files their flags name read in: `--css` becomes the stylesheet, and
// `--pdf-header` and `--pdf-footer` the PDF's header and footer HTML. A file that cannot be read
// is a bad argument.
function readCSSAndPDFHeaderAndFooterFiles(
  recordRequest: RecordRequest,
  cwd: string,
): Task<RecordOptions, Failure.Of<typeof InvalidRecordArgument>> {
  const named: [flag: string, file: string | undefined, into: (text: string) => RecordOptions][] = [
    ['--css', recordRequest.cssFile, (css) => ({ css })],
    ['--pdf-header', recordRequest.pdfHeaderFile, (header) => ({ pdf: { header } })],
    ['--pdf-footer', recordRequest.pdfFooterFile, (footer) => ({ pdf: { footer } })],
  ];
  return Task(async () => {
    const read = await Promise.all(
      named
        .filter(([, file]) => file !== undefined)
        .map(async ([flag, file, into]) => {
          const full = path.resolve(cwd, file!);
          const text = await readFile(full, 'utf8').catch(() => {
            throw InvalidRecordArgument({
              argument: `${flag} ${file}`,
              reason: `no such file (${full})`,
            });
          });
          return into(text);
        }),
    );
    return read.reduce<RecordOptions>(
      (options, part) =>
        part.pdf ? { ...options, pdf: { ...options.pdf, ...part.pdf } } : { ...options, ...part },
      recordRequest.options,
    );
  });
}

async function describeOutputFileDetails(
  file: RecordResult['files'][number],
  displayPath: (file: string) => Promise<string>,
): Promise<string> {
  const frames =
    file.format === 'pdf'
      ? `  ${file.frames} page${file.frames === 1 ? '' : 's'}`
      : file.frames > 1
        ? `  ${file.frames} frames`
        : '';
  const line = `${await displayPath(file.path)}  ${file.width}×${file.height}${frames}`;
  const comparison = file.comparison;
  if (!comparison) return `${line}  ${size(file.bytes)}`;
  else if (comparison.status !== 'changed') return `${line}  ${comparison.status}`;
  const share = ((comparison.changedPixels / comparison.totalPixels) * 100).toFixed(2);
  const review = await Promise.all(
    [comparison.diffPath, comparison.currentPath]
      .filter((review) => review !== null)
      .map((review) => displayPath(review)),
  );
  return `${line}  changed: ${comparison.changedPixels.toLocaleString('en-US')} pixels (${share}%) → ${review.join(', ')}`;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  else if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// `qunitx record --help`: built when it is shown, not every time the module loads.
function usage(): string {
  return `${magenta().bold(`[qunitx v${pkg.version}] Usage:`)} qunitx ${blue('record <url | page.html | dir | script.ts>... [-f formats] [-w width] [-h height]')}

${magenta().bold('Examples:')}
${blue('$ qunitx record https://example.com')}                     # example.com.jpg
${blue('$ qunitx record https://example.com -f home.png -w 1200')} # home.png, 1200px wide
${blue('$ qunitx record a.html b.html')}                           # a.jpg, b.jpg and recording.gif of both
${blue('$ qunitx record http://a.com -f a.gif, a.jpg')}            # exactly those two files
${blue('$ qunitx record demo.ts -w 1200 -h 1200')}                  # demo.gif of the script running, demo.jpg of where it ended
${blue('$ qunitx record demo.ts -f demo.mp4,demo.webm')}            # the same as video: H.264 and VP9, encoded by the browser
${blue('$ qunitx record dist/ -f png --full-page -o shots')}        # shots/dist.png, the whole page
${blue('$ qunitx record dist/ about.html -o snapshots --compare')}   # compare with the pngs already there; exit 1 on a change

${blue('$ qunitx record intro.md app.tour.ts -f demo.html --panel=below')} # demo.html: every step, clickable
${blue('$ qunitx record invoice.html -f pdf --pdf-paper=A4 --pdf-media=print')} # invoice.pdf, printed on A4

${magenta().bold('Inputs:')} a ${blue('http(s)://')} or ${blue('file://')} URL, an ${blue('.html')} file or a directory with an ${blue('index.html')} (served from a local origin),
or a ${blue('.js/.ts/.jsx/.tsx')} script, run as ${blue('qunitx run')} would and recorded while it runs.
A script can ${blue('await globalThis.qunitxRecordFrame?.()')} after drawing a step to make sure that step is in the recording.
A ${blue('.tour.ts')} file, or any script that does ${blue('export default tour(…)')}, drives the browser for a walkthrough: a cursor that clicks, hovers and types, zooms, captions, tabs.
  ${blue("export default tour(async (t) => { await t.goto(url); await t.click('#add'); await t.zoom('#cart'); })")}
  Steps: goto, move, click, doubleClick, tap, hover, rightClick, longPress, pinch, type, fill, press, select, upload,
  scroll ({ y: -600 } up, { within: '#list' }), drag, swipe,
  zoom, zoomOut, caption, highlight, chapter, wait,
  live, snap, open, switchTo, close; t.tabs lists every tab. ${blue('tour({ touch: true }, …)')} records a phone: real taps and
  swipes, a fingertip instead of the cursor, a phone frame (${blue("frame: 'phone' | 'browser' | 'none'")}, ${blue('addressBar: false')} for an app).
  Restyle with CSS: ${blue("caption: { placement: 'top', style: { borderRadius: 0 } }")}, and ${blue('style')} on ${blue('cursor')}, ${blue('finger')},
  ${blue('ripple')}, ${blue('menu')}, ${blue('phone')} and ${blue('browser')}, or a whole stylesheet in ${blue('css')};
  ${blue("rightClick(target, { menu: ['Copy', 'Paste'], choose: 'Paste' })")} draws a menu the page itself doesn't.
  Touch gestures take ${blue('fingers: 1-10')} (${blue("t.swipe('#map', 'left', { fingers: 3 })")}); ${blue('pinch(target, { fingers: 5, rotate: 90 })')} twists.
  ${blue("t.step('Pay', { notes })")} starts a step: titled in the panel, and a stop in the HTML player.
A ${blue('.md')} file is a deck, a slide per ${blue('---')} (${blue('Note:')} starts a slide's speaker notes); an image (${blue('.png .jpg .gif .webp .svg')}) is one slide.
Every input becomes steps of one recording: a GIF, or with ${blue('-f demo.html')} a player to click or key through (← →, Home, End, K),
or with ${blue('-f demo.pdf')} a document, a page a step, its panel and notes on it.

${magenta().bold('Flags:')}
${blue('-f, --format')}    : formats (${blue('png')}, ${blue('jpg')}, ${blue('gif')}, ${blue('webm')}, ${blue('mp4')}, ${blue('html')}, ${blue('pdf')}) or file names ending in one, comma-separated. Default: ${blue('jpg')} for one page, ${blue('jpg,gif')} for several inputs or a script
${blue('-w, --width')}     : viewport width in CSS pixels (default ${DEFAULT_SIZE.width})
${blue('-h, --height')}    : viewport height in CSS pixels (default ${DEFAULT_SIZE.height})
${blue('-o, --output')}    : directory the files are written to (default: the current one)
${blue('--scale')}         : device pixel ratio, e.g. ${blue('2')} for retina (default 1)
${blue('--full-page')}     : stills capture the whole scrollable page, not just the viewport
${blue('--wait-for')}      : after a page loads, wait this many ms, or until this CSS selector is on it
${blue('--page-duration')} : record each page for this many ms in a GIF, instead of one still
${blue('--last-frame-duration')} : ms each input's last frame stays on screen in a GIF (default 1000)
${blue('--fps')}           : most frames per second a GIF keeps (default 10)
${blue('--quality')}       : jpg quality, 0-100 (default 90)
${blue('--browser')}       : chromium, firefox or webkit (default chromium)
${blue('--timeout')}       : ms a script may run, or a page may take to load, before giving up
${blue('-p, --port')}      : first port tried for the local server
${blue('--panel')}         : ${blue('above')} or ${blue('below')}: a band with each step's title, caption and progress
${blue('--css')}           : a stylesheet file for the panel, the player, slides and every frame (${blue('#panel')}, ${blue('.slide h1')}…)
${blue('--backdrop')}      : the CSS background around parts smaller than the recording, and the player's page
${blue('--advance')}       : the player: ${blue('click')} (default) waits after each step, ${blue('auto')} plays on
${blue('--loop')}          : the player starts again after the last step
${blue('--no-autoplay')}   : the player waits for the first click or key
${blue('--html-assets')}   : ${blue('inline')} (default): one file; ${blue('files')}: its pictures in a folder beside it

${magenta().bold('Visual diff:')}
${blue('--compare')}       : a png already at an output path is the baseline: compare instead of overwriting, writing
                  ${blue('<name>.diff.png')} and ${blue('<name>.new.png')} beside it when it changed (exit 1). Defaults ${blue('-f')} to png
${blue('--update')}        : accept the changes: new screenshots replace their baselines
${blue('--threshold')}     : how far a pixel's color may move before it counts, 0-1 (default 0.1)
${blue('--max-diff')}      : how many pixels may change before a snapshot counts as changed (default 0)
${blue('--report')}        : also write ${blue('report.html')} beside the snapshots: changed ones first, each diff with a wipe from baseline to new;
                  ${blue('--report=pdf')} writes ${blue('report.pdf')} (with the ${blue('--pdf-*')} settings), ${blue('--report=html,pdf')} both
${blue('--pr-comment')}    : also write ${blue('comment.md')}, a pull-request comment with each changed snapshot's diff (alias ${blue('--comment')})
${blue('--images-url')}    : the URL the workflow publishes the snapshots folder at, which the comment's images link to (needed by ${blue('--pr-comment')})
${blue('--report-url')}    : where the comment's "Download the full report" link points, e.g. the CI run's artifacts
${blue('--mask')}          : CSS selector of something that changes on its own, e.g. a clock or an avatar: covered on both sides, so comparing ignores it; repeatable

${magenta().bold('package.json:')} ${blue('"qunitx": { "record": { "inputs": [...], "width": 1280, "mask": ["#clock"], ... } }')}
sets the same options by their long names (${blue('fullPage')}, ${blue('maxDiff')}, ${blue('prComment')}…), paths relative to package.json,
and ${blue('"pdf": { "paper": "A4", "margin": "12mm", … }')} the PDF settings (HTML in ${blue('header')}/${blue('footer')}).
${blue('qunitx record')} with no inputs records the configured ones; flags given on the command line win.

${magenta().bold('PDF:')} ${blue('-f pdf')} prints each page where it ended: vector (text and links kept) in chromium, its screenshots on pages elsewhere.
${blue('--pdf-paper')}     : ${blue('fit')} (default: one page the page's size), ${blue('A4')}, ${blue('Letter')}, ${blue('Legal')}, ${blue('A3')}…, or ${blue('20cmx30cm')}
${blue('--pdf-landscape')} : turn a named paper sideways
${blue('--pdf-margin')}    : around the content, e.g. ${blue('12mm')}, ${blue('0.5in')} (default 0)
${blue('--pdf-scale')}     : zoom of the printed page, 0.1-2 (default 1)
${blue('--pdf-media')}     : the CSS media the page is laid out for — which media queries match and stylesheets apply:
                  ${blue('screen')} (default: as the browser shows it) or ${blue('print')} (its print styles, as Ctrl+P would)
${blue('--pdf-mode')}      : ${blue('auto')} (default), ${blue('vector')} (default on chromium only) or ${blue('raster')}
${blue('--pdf-header')}, ${blue('--pdf-footer')} : HTML template files (${blue('.pageNumber')}, ${blue('.totalPages')}, ${blue('.title')}, ${blue('.date')}, ${blue('.url')} filled in; vector)
${blue('--pdf-pages')}     : which pages to keep, e.g. ${blue('1-3,5')} (vector)
${blue('--pdf-outline')}   : add PDF bookmarks — a reader's clickable sidebar — from the page's h1–h6 headings (vector)
${blue('--no-pdf-background')} : leave backgrounds out, as a printer would

${magenta().bold('Exit codes:')} ${blue('0')} recorded, ${blue('1')} a script failed, a snapshot changed, or an input could not be recorded, ${blue('2')} bad arguments.
`;
}
