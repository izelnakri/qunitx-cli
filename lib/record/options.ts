import * as Failure from '../result/failure.ts';
import { fromConsoleOptionOrElse, processConsole } from '../console.ts';
import * as CSS from './css.ts';
import { PAPERS } from './pdf.ts';
import type { RecordOptions } from './index.ts';

// Past this a single frame is hundreds of megabytes of pixels, which is a typo, not a request.
const MAX_SIDE = 16_384;
const PAPER_NAMES = ['fit', ...Object.keys(PAPERS)];
const MARGIN_SIDES = ['top', 'right', 'bottom', 'left'];
const PAGE_RANGES_PATTERN = /^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/;

/**
 * Frames a second a capture keeps at most when not told otherwise: `qunitx record --fps`'s default.
 *
 * ```ts
 * import { DEFAULT_FPS } from './options.ts';
 *
 * 1000 / DEFAULT_FPS; // 100 — the shortest interval between two timed frames, in ms
 * ```
 */
export const DEFAULT_FPS = 10;

/**
 * The engines `record` can drive.
 *
 * ```ts
 * import { BROWSERS } from './options.ts';
 *
 * BROWSERS.includes('webkit'); // true
 * ```
 */
export const BROWSERS = ['chromium', 'firefox', 'webkit'] as const;

/**
 * The viewport a recording gets when neither `width` nor `height` is given.
 *
 * ```ts
 * import { DEFAULT_SIZE } from './options.ts';
 *
 * DEFAULT_SIZE.width; // 1280
 * ```
 */
export const DEFAULT_SIZE: { width: number; height: number } = { width: 1280, height: 720 };

/**
 * The options a recording runs with: every option given, and the default of every one that was
 * not. `cwd`, `output`, `formats` and `pdf` are read where they are used, not here.
 *
 * ```ts
 * import type { Settings } from './options.ts';
 *
 * const settings: Pick<Settings, 'fps' | 'lastFrameDuration'> = { fps: 10, lastFrameDuration: 1000 };
 * ```
 */
export type Settings = Required<
  Omit<
    RecordOptions,
    | 'cwd'
    | 'output'
    | 'formats'
    | 'pageDuration'
    | 'waitFor'
    | 'timeout'
    | 'update'
    | 'pdf'
    | 'upload'
  >
> &
  Pick<RecordOptions, 'pageDuration' | 'waitFor'> & { timeout: number | null; accept: boolean };

// A rule a value is held to: its test, and what it expects, for the message when it fails.
interface Rule {
  test: (value: unknown) => boolean;
  expected: string | ((value: unknown) => string);
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;
const defineRule = (test: Rule['test'], expected: Rule['expected']): Rule => ({ test, expected });
const wholeNumberBetween = (min: number, max: number, unit = ''): Rule =>
  defineRule(
    (value) => Number.isInteger(value) && (value as number) >= min && (value as number) <= max,
    `a whole number ${unit}from ${min} to ${max}`,
  );
const oneOf = (values: readonly unknown[], expected: string): Rule =>
  defineRule((value) => values.includes(value), expected);
const TRUE_OR_FALSE = defineRule((value) => typeof value === 'boolean', 'true or false');
// What each field of an upload holds.
const UPLOAD_FIELDS: Record<string, (entry: unknown) => boolean> = {
  to: (entry) => entry === 'google',
  folder: (entry) => isString(entry) && entry !== '',
  convert: (entry) => typeof entry === 'boolean',
};
const NON_EMPTY_PATH = defineRule((value) => isString(value) && value !== '', 'a path');
// A length a PDF takes: CSS pixels as a number, or a number with px, in, cm, mm or pt.
const isCSSLength = (value: unknown, positive = false): boolean => {
  const pixels = typeof value === 'number' || isString(value) ? CSS.toPixels(value) : NaN;
  return Number.isFinite(pixels) && (positive ? pixels > 0 : pixels >= 0);
};

// Every option's rule, for the command line and the JS API alike. An option not here is not checked.
const RULES: Record<string, Rule> = {
  width: wholeNumberBetween(1, MAX_SIDE, 'of pixels '),
  height: wholeNumberBetween(1, MAX_SIDE, 'of pixels '),
  pageDuration: wholeNumberBetween(1, 600_000),
  lastFrameDuration: wholeNumberBetween(0, 600_000),
  fps: wholeNumberBetween(1, 50),
  quality: wholeNumberBetween(0, 100),
  timeout: wholeNumberBetween(1, Number.MAX_SAFE_INTEGER),
  port: wholeNumberBetween(0, 65_535),
  maxDiff: wholeNumberBetween(0, Number.MAX_SAFE_INTEGER),
  threshold: defineRule(
    (value) => typeof value === 'number' && value >= 0 && value <= 1,
    'a fraction from 0 to 1',
  ),
  compare: TRUE_OR_FALSE,
  update: TRUE_OR_FALSE,
  mask: defineRule(
    (value) => Array.isArray(value) && value.every(isString),
    'a list of CSS selectors',
  ),
  scale: defineRule(
    (value) => typeof value === 'number' && value > 0 && value <= 4,
    'a number above 0 and up to 4',
  ),
  browser: oneOf(BROWSERS, `one of ${BROWSERS.join(', ')}`),
  waitFor: defineRule(
    (value) =>
      (Number.isInteger(value) && (value as number) >= 0) ||
      (isString(value) && value.trim() !== ''),
    'a number of ms or a CSS selector',
  ),
  fullPage: TRUE_OR_FALSE,
  cwd: NON_EMPTY_PATH,
  output: NON_EMPTY_PATH,
  upload: defineRule(
    (value) =>
      value === 'google' ||
      (typeof value === 'object' &&
        value !== null &&
        (value as { to?: unknown }).to === 'google' &&
        Object.entries(value).every(
          ([field, entry]) => entry === undefined || UPLOAD_FIELDS[field]?.(entry),
        )),
    "'google' or { to: 'google', folder, convert }",
  ),
  formats: defineRule(
    (value) => Array.isArray(value) && value.every(isString),
    'a list of formats or file names',
  ),
};

// Each PDF setting's rule.
const PDF_RULES: Record<string, Rule> = {
  mode: oneOf(['auto', 'vector', 'raster'], "'auto', 'vector' or 'raster'"),
  paper: defineRule(
    (value) =>
      isString(value)
        ? PAPER_NAMES.includes(value)
        : isObject(value) &&
          isCSSLength((value as { width?: unknown }).width, true) &&
          isCSSLength((value as { height?: unknown }).height, true),
    (value) =>
      isString(value)
        ? `one of ${PAPER_NAMES.join(', ')}`
        : 'a paper name or { width, height } in px, in, cm, mm or pt',
  ),
  margin: defineRule(
    (value) =>
      isObject(value)
        ? Object.entries(value).every(
            ([side, size]) => MARGIN_SIDES.includes(side) && isCSSLength(size),
          )
        : isCSSLength(value),
    (value) =>
      isObject(value) ? 'a length, or { top, right, bottom, left } of lengths' : 'a length',
  ),
  scale: defineRule(
    (value) => typeof value === 'number' && value >= 0.1 && value <= 2,
    'a number from 0.1 to 2',
  ),
  media: oneOf(['screen', 'print'], "'screen' or 'print'"),
  header: defineRule(isString, 'an HTML template'),
  footer: defineRule(isString, 'an HTML template'),
  pageRanges: defineRule(
    (value) => isString(value) && PAGE_RANGES_PATTERN.test(value),
    "page ranges such as '1-3, 5'",
  ),
  landscape: TRUE_OR_FALSE,
  background: TRUE_OR_FALSE,
  outline: TRUE_OR_FALSE,
};

/**
 * A `record` option the JS API was given that it cannot use: a value out of its range, or of the
 * wrong kind.
 *
 * ```ts
 * import { InvalidRecordOption } from './options.ts';
 *
 * InvalidRecordOption({ option: 'fps', reason: 'expected a whole number from 1 to 50, got 0' }).message;
 * // 'record option fps: expected a whole number from 1 to 50, got 0'
 * ```
 */
export const InvalidRecordOption: Failure.FailureFactory<
  'InvalidRecordOption',
  { option: string; reason: string }
> = Failure.define(
  'InvalidRecordOption',
  (data: { option: string; reason: string }) => `record option ${data.option}: ${data.reason}`,
);

/**
 * `options` with a default for each one not given: the settings a recording runs with.
 *
 * ```ts
 * import * as Options from './options.ts';
 *
 * Options.from({ width: 800 }).height; // 720
 * Options.from({}).fps; // 10
 * ```
 */
export function from(options: RecordOptions): Settings {
  return {
    width: options.width ?? DEFAULT_SIZE.width,
    height: options.height ?? DEFAULT_SIZE.height,
    scale: options.scale ?? 1,
    browser: options.browser ?? 'chromium',
    fullPage: options.fullPage ?? false,
    waitFor: options.waitFor,
    pageDuration: options.pageDuration,
    lastFrameDuration: options.lastFrameDuration ?? 1000,
    fps: options.fps ?? DEFAULT_FPS,
    quality: options.quality ?? 90,
    timeout: options.timeout ?? null,
    port: options.port ?? 1234,
    console: fromConsoleOptionOrElse(options.console, processConsole),
    compare: Boolean(options.compare || options.update),
    accept: options.update ?? false,
    threshold: options.threshold ?? 0.1,
    maxDiff: options.maxDiff ?? 0,
    mask: options.mask ?? [],
  };
}

/**
 * Why `value` will not do for `option`, or null when it will: the one set of rules the command
 * line's flags and the JS API's options are both held to. `shown` is how the value is quoted back.
 *
 * ```ts
 * import { invalidOptionReason } from './options.ts';
 *
 * invalidOptionReason('fps', 60); // 'expected a whole number from 1 to 50, got 60'
 * invalidOptionReason('width', 1200); // null
 * invalidOptionReason('scale', 0, '"0"'); // 'expected a number above 0 and up to 4, got "0"'
 * ```
 */
export function invalidOptionReason(
  option: string,
  value: unknown,
  shown: string = JSON.stringify(value) ?? String(value),
): string | null {
  if (option === 'pdf') return invalidPdfReason(value, shown);
  const rule = RULES[option];
  return !rule || rule.test(value)
    ? null
    : `expected ${describeExpected(rule, value)}, got ${shown}`;
}

/**
 * Throws the first option of `options` that {@link invalidOptionReason} turns down, as an
 * {@link InvalidRecordOption}; returns when they all will do. `timeout: null` is the API's way to
 * say "no timeout", and is fine.
 *
 * ```ts
 * import { validate, InvalidRecordOption } from './options.ts';
 *
 * validate({ width: 1200, fps: 20 }); // nothing: every option will do
 * try {
 *   validate({ quality: 101 });
 * } catch (failure) {
 *   InvalidRecordOption.is(failure); // true
 * }
 * ```
 */
export function validate(options: RecordOptions): void {
  const [option, reason] =
    Object.entries(options)
      .filter(([option, value]) => value !== undefined && !(option === 'timeout' && value === null))
      .map(([option, value]) => [option, invalidOptionReason(option, value)] as const)
      .find(([, reason]) => reason !== null) ?? [];
  if (option && reason) throw InvalidRecordOption({ option, reason });
}

function invalidPdfReason(value: unknown, shown: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return `expected an object of PDF settings, got ${shown}`;
  }
  // The first setting that is not one, or does not hold to its rule.
  const [field, entry] =
    Object.entries(value).find(
      ([field, entry]) => entry !== undefined && !PDF_RULES[field]?.test(entry),
    ) ?? [];
  if (field === undefined) return null;
  else if (!(field in PDF_RULES)) {
    return `has no setting ${field}; expected ${Object.keys(PDF_RULES).join(', ')}`;
  }
  // A function, say, has no JSON: its type says what it is.
  const got = JSON.stringify(entry) ?? typeof entry;
  return `${field}: expected ${describeExpected(PDF_RULES[field], entry)}, got ${got}`;
}

function describeExpected(rule: Rule, value: unknown): string {
  return typeof rule.expected === 'function' ? rule.expected(value) : rule.expected;
}
