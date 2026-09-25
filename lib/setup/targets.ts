// What `--browser` takes. One list, because it used to be four: `lib/args/parse.ts` had it twice,
// `lib/api/options.ts` had its own copy, and `lib/types.ts` restated it as a union — so a value
// added in three places out of four was a value that parsed and then failed somewhere quieter.

/**
 * The engines a test run can use. A run needs a document, so this is the whole list for one.
 *
 * ```ts
 * import { BROWSERS } from './targets.ts';
 *
 * BROWSERS.includes('chromium'); // true
 * ```
 */
export const BROWSERS = ['chromium', 'firefox', 'webkit'] as const;

/**
 * The runtimes a PROMPT can open on. Not a test run: neither of them has a document.
 *
 * ```ts
 * import { RUNTIMES } from './targets.ts';
 *
 * RUNTIMES.join(' and '); // 'node and deno'
 * ```
 */
export const RUNTIMES = ['node', 'deno'] as const;

/**
 * Everything `--browser` accepts, in the order the help lists them.
 *
 * ```ts
 * import { TARGETS } from './targets.ts';
 *
 * TARGETS.length; // 5
 * ```
 */
export const TARGETS = [...BROWSERS, ...RUNTIMES] as const;

/** One of the three engines — what `Browser.launch` and every run path mean by a browser. */
export type BrowserName = (typeof BROWSERS)[number];

/** `node` or `deno`: a V8 with an inspector on it and no page anywhere. */
export type RuntimeName = (typeof RUNTIMES)[number];

/** Anything `--browser` can be set to. */
export type TargetName = (typeof TARGETS)[number];

/**
 * Whether a target is a runtime rather than a browser.
 *
 * ```ts
 * import { isRuntime } from './targets.ts';
 *
 * isRuntime('node'); // true
 * isRuntime('chromium'); // false
 * ```
 */
export function isRuntime(target: string | undefined): target is RuntimeName {
  return target === 'node' || target === 'deno';
}
