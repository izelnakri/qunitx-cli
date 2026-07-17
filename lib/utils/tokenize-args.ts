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
const QUERY_FLAG_ACTION = new Map<string, 'run' | 'list'>([
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
  /** What to do with the matches: `run` narrows which tests execute; `list` previews them instead. */
  action: 'run' | 'list';
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
  // The fold carries two bits of cross-entry state: `rest` (past the `--` marker, everything is a
  // positional input) and `greedy` (the bare query flag currently absorbing following words — held
  // by reference so its value grows in place, no rescan or post-pass join needed).
  return args.reduce<{ tokens: ArgToken[]; greedy: QueryToken | null; rest: boolean }>(
    (state, arg) => {
      const { tokens, greedy } = state;

      if (state.rest) {
        tokens.push({ kind: 'input', raw: arg });
      } else if (arg === '--') {
        state.rest = true;
        state.greedy = null;
      } else if (greedy && arg !== '-' && !arg.startsWith('-')) {
        // Another bare word for the flag mid-absorption: extend its value in place.
        greedy.value = greedy.value === null ? arg : `${greedy.value} ${arg}`;
      } else {
        // A flag or input ends any greedy run before it is classified afresh.
        state.greedy = null;
        const equalsAt = arg.indexOf('=');
        const action = QUERY_FLAG_ACTION.get(equalsAt === -1 ? arg : arg.slice(0, equalsAt));
        if (action && equalsAt !== -1) {
          // `--filter=x` — single token; the value keeps its own `=`/spaces/dashes intact.
          tokens.push({ kind: 'query', action, value: arg.slice(equalsAt + 1), greedy: false });
        } else if (action) {
          // Bare `-t` — open a greedy token that following non-flag entries append to.
          state.greedy = { kind: 'query', action, value: null, greedy: true };
          tokens.push(state.greedy);
        } else if (arg.startsWith('-') && arg !== '-') {
          tokens.push({ kind: 'flag', raw: arg });
        } else {
          tokens.push({ kind: 'input', raw: arg });
        }
      }

      return state;
    },
    { tokens: [], greedy: null, rest: false },
  ).tokens;
}

export { tokenizeArgs as default };
