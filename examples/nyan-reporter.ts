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
import { run, type Reporter, type ReporterContext, type TestDetails } from '../lib/api/index.ts';

const FIXTURES = ['test/fixtures/passing-tests.ts', 'test/fixtures/skip-todo-tests.ts'];

// The six rainbow rows, and the two frames the cat's legs alternate between.
const RAINBOW = [31, 33, 32, 36, 34, 35] as const;
const CAT = ['~=[,,_,,]:3', '~=[,,__,,]:3'] as const;
const paint = (code: number, text: string): string =>
  process.env.NO_COLOR ? text : `\x1b[${code}m${text}\x1b[39m`;

/**
 * One rainbow segment per test: `-` for a pass, `!` for a failure, `·` for skip/todo.
 *
 * QUnit reports `passed | failed | skipped | todo`, and the reporter contract hands the whole
 * `TestDetails` to `onTestEnd`, so the mapping is a lookup rather than a guess.
 */
function segment(status: TestDetails['status']): string {
  if (status === 'failed') return paint(31, '!');
  else if (status === 'skipped' || status === 'todo') return paint(90, '·');

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
        const stripe = paint(colour, trail.slice(Math.max(0, row - 2)).join(''));
        return `  ${stripe}${row === 3 ? paint(93, CAT[trail.length % 2]) : ''}`;
      });
      context.console.log(`${rows.join('\n')}\n\x1b[6A`);
    },

    onRunEnd(context: ReporterContext, info): void {
      // `context.counts` is the run's live counter, so it is already final here — no need to
      // tally anything yourself.
      const { total, passed, failed, skipped, todo } = context.counts;
      const verdict = failed > 0 ? paint(31, 'nyan is sad') : paint(32, 'nyan is happy');

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
const result = await run({
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
