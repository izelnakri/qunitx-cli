// A nyan cat reporter, built on the public `Reporter` contract — the smallest interesting thing
// you can plug into a qunitx run. It draws a rainbow that grows one segment per finished test,
// coloured by outcome, with the cat riding the end of it.
//
// It runs the REAL lib/api/ against this repository's own fixtures, so what you read here is what
// a reporter of your own would actually receive.
//
// run:   node examples/nyan-reporter.ts
// check: deno check examples/nyan-reporter.ts
//
// What it demonstrates:
//   1. `Reporter`         — the five hooks, all optional; implement only what you need
//   2. `ReporterContext`  — what a hook is given: where to write, the live counts, the paths
//   3. `context.console`  — why a reporter never touches `process.stdout` itself
//   4. composition        — your reporter runs alongside a built-in one, and the result is
//                           still returned either way
import process from 'node:process';
import { test, type Reporter, type ReporterContext, type TestDetails } from '../lib/api/index.ts';

const FIXTURES = ['test/fixtures/passing-tests.ts', 'test/fixtures/skip-todo-tests.ts'];

// The ANSI colours this reporter uses, named — `inColor(RED, '!')` says what it draws, and
// `inColor(31, '!')` makes a reader go and look 31 up.
const RED = 31;
const GREEN = 32;
const YELLOW = 33;
const BLUE = 34;
const MAGENTA = 35;
const CYAN = 36;
const GREY = 90;
const BRIGHT_YELLOW = 93;

// The six rainbow rows, and the two frames the cat's legs alternate between.
const RAINBOW = [RED, YELLOW, GREEN, CYAN, BLUE, MAGENTA] as const;
const CAT = ['~=[,,_,,]:3', '~=[,,__,,]:3'] as const;

/**
 * Text in one of those colours, or the bare text where the environment asked for none.
 *
 * The colour first, because every call here reads `inColor(RED, …)`. Honouring `NO_COLOR` is the
 * one thing a reporter that writes escapes has to remember: a reporter whose output is piped into
 * a file or compared by a script must be able to produce plain text.
 */
const inColor = (code: number, text: string): string =>
  process.env.NO_COLOR ? text : `\x1b[${code}m${text}\x1b[39m`;

/**
 * One rainbow segment per test: `-` for a pass, `!` for a failure, `·` for skip/todo.
 *
 * QUnit reports `passed | failed | skipped | todo`, and the reporter contract hands the whole
 * `TestDetails` to `onTestEnd`, so the mapping is a lookup rather than a guess.
 */
function segment(status: TestDetails['status']): string {
  if (status === 'failed') return inColor(RED, '!');
  else if (status === 'skipped' || status === 'todo') return inColor(GREY, '·');

  return '-';
}

/**
 * The reporter itself. Every hook is optional — this one ignores `onNotice` and `onBrowserLog`
 * entirely, and qunitx simply never calls them.
 *
 * Note what each hook receives: a {@link ReporterContext}, NOT the run's config. It carries the
 * few things a reporter needs — `console`, the live `counts`, `projectRoot` — and nothing it
 * could break by writing to.
 */
export function nyanReporter(): Reporter {
  const trail: string[] = [];

  return {
    onRunStart(context: ReporterContext, info): void {
      const files = info.fileCount ?? 0;
      context.console.log(`\n  nyan is running ${files} file${files === 1 ? '' : 's'}\n\n`);
    },

    onTestEnd(context: ReporterContext, details: TestDetails): void {
      trail.push(segment(details.status));
      // Redraw in place: six rainbow rows, each one character further along than the last, with
      // the cat at the head of the middle row. `\x1b[6A` walks the cursor back up over them.
      const rows = RAINBOW.map((colour, row) => {
        const stripe = inColor(colour, trail.slice(Math.max(0, row - 2)).join(''));
        return `  ${stripe}${row === 3 ? inColor(BRIGHT_YELLOW, CAT[trail.length % 2]) : ''}`;
      });
      context.console.log(`${rows.join('\n')}\n\x1b[6A`);
    },

    onRunEnd(context: ReporterContext, info): void {
      // `context.counts` is the run's live counter, so it is already final here — no need to
      // tally anything yourself.
      const { total, passed, failed, skipped, todo } = context.counts;
      const verdict = failed > 0 ? inColor(RED, 'nyan is sad') : inColor(GREEN, 'nyan is happy');

      context.console.log(
        `\x1b[6B\n  ${verdict} — ${passed}/${total} passed` +
          `${failed ? `, ${failed} failed` : ''}` +
          `${skipped ? `, ${skipped} skipped` : ''}` +
          `${todo ? `, ${todo} todo` : ''}` +
          ` in ${info.durationMs}ms\n`,
      );
    },
  };
}

// `reporter` takes one, `reporters` takes several — so a reporter of your own can sit next to a
// built-in. Passing an OBJECT does not turn printing on by itself; naming a built-in does, which
// is why `console` here is the process streams rather than silence.
const result = await test({
  inputs: FIXTURES,
  output: 'tmp/nyan-example',
  reporter: nyanReporter(),
  console: {
    log: (text) => void process.stdout.write(text),
    error: (text) => void process.stderr.write(text),
  },
});

// The result comes back whatever the reporter did with it — printing and answering are separate.
process.exitCode = result.ok ? 0 : 1;
