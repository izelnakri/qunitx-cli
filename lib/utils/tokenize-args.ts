/**
 * The single left-to-right classification of a qunitx argv (already sliced past the node binary
 * and script path). Both `parseCliFlags` and the daemon's `isDaemonEligible` consume these tokens,
 * so the one thing they must agree on — how many argv entries a value flag swallows — is decided
 * here, in one place, and can never drift between the two scanners again.
 */

/**
 * Every spelling of the two query flags. `-t`/`--filter`/`-m`/`--module` are four names for ONE
 * matcher — QUnit's `config.filter`, run against `"Module: test name"` — so `-m Coupons` finds a
 * nested module and `-m Cart check` finds "Cart checkout", neither of which QUnit's exact
 * `config.module` could. Reach for `-t '/^Cart(:| >)/'` when you need exactly one module and not
 * its similarly-named siblings. `-n` is a fourth short alias (mnemonic: by name).
 *
 * `--search`/`-s`/`--print`/`-p`/`--preview` are the same idea for the "list, don't run" mode.
 *
 * A Map, not a plain object: a positional input literally named `__proto__` or `constructor`
 * would resolve to a truthy value on an object's prototype and be misread as a query flag.
 */
const QUERY_FLAG_KEY = new Map<string, 'run' | 'list'>([
  ['-t', 'run'],
  ['--filter', 'run'],
  ['-m', 'run'],
  ['--module', 'run'],
  ['-n', 'run'],
  ['-s', 'list'],
  ['--search', 'list'],
  ['-p', 'list'],
  ['--print', 'list'],
  ['--preview', 'list'],
]);

/** A query flag (`-t`/`-m`/`-s`/`-p`) with its resolved value. */
export interface QueryToken {
  /** Discriminant. */
  kind: 'query';
  /** The query mode: `run` narrows which tests execute; `list` previews matches without running. */
  key: 'run' | 'list';
  /** The value, or null when the flag was given with nothing after it. */
  value: string | null;
  /** True when the value was consumed from following argv entries (`-t a b`) rather than `=` glued. */
  greedy: boolean;
}

/** Any other flag (`--watch`, `--timeout=5000`, `-o`, …), passed through verbatim. */
export interface FlagToken {
  /** Discriminant. */
  kind: 'flag';
  /** The exact argv entry, including leading dashes and any `=value`. */
  raw: string;
}

/** A positional target: a file, folder, or glob (possibly with a `#34` line suffix). */
export interface InputToken {
  /** Discriminant. */
  kind: 'input';
  /** The exact argv entry. */
  raw: string;
}

/** One classified argv entry: a query flag, any other flag, or a positional input. */
export type ArgToken = QueryToken | FlagToken | InputToken;

/**
 * Classifies argv into query / flag / input tokens.
 *
 * A bare query flag (`-t`, no `=`) is **greedy**: it swallows every following entry up to — but not
 * including — the next `-`-prefixed entry (or end of argv), joined with spaces. That is what lets
 * `-t Some Module loading tests --junit` read as filter `"Some Module loading tests"` without
 * quotes. The `=` form (`--filter=x`) stays a single token, so a value that legitimately starts
 * with `-` is still reachable that way.
 *
 * A `--` entry is the POSIX end-of-options marker: everything after it is a positional input, so
 * `-t a b -- test/foo` scopes the run to `test/foo` while keeping `"a b"` as the filter.
 */
export function tokenizeArgs(args: string[]): ArgToken[] {
  const tokens: ArgToken[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--') {
      for (let j = i + 1; j < args.length; j++) {
        tokens.push({ kind: 'input', raw: args[j] });
      }
      break;
    }

    const equalsAt = arg.indexOf('=');
    const head = equalsAt === -1 ? arg : arg.slice(0, equalsAt);
    const key = QUERY_FLAG_KEY.get(head);

    if (key && equalsAt !== -1) {
      // `--filter=x` — single token; the value keeps its own `=`/spaces/dashes intact.
      tokens.push({ kind: 'query', key, value: arg.slice(equalsAt + 1), greedy: false });
    } else if (key) {
      // Bare `-t` — greedily absorb following non-flag entries as the value.
      const words: string[] = [];
      while (i + 1 < args.length && args[i + 1] !== '--' && !args[i + 1].startsWith('-')) {
        words.push(args[++i]);
      }
      tokens.push({
        kind: 'query',
        key,
        value: words.length ? words.join(' ') : null,
        greedy: true,
      });
    } else if (arg.startsWith('-') && arg !== '-') {
      tokens.push({ kind: 'flag', raw: arg });
    } else {
      tokens.push({ kind: 'input', raw: arg });
    }
  }

  return tokens;
}

export { tokenizeArgs as default };
