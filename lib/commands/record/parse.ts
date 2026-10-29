import process from 'node:process';
import * as Outputs from '../../record/outputs.ts';
import { Failure, type Result } from '../../result/index.ts';
import { invalidOptionReason } from '../../record/options.ts';
import type { RecordOptions } from '../../record/index.ts';
import type { PdfOptions } from '../../record/pdf.ts';

// `qunitx record`'s arguments, read in one walk over argv against the FLAGS table. (The binary's
// own arguments are tokenized first, in lib/args, because two readers share those tokens; this
// has one.)

/**
 * What a `qunitx record` flag sets — an option (`width`), a PDF setting (`pdf.paper`), part of the
 * request (`help`), or nothing — and how: `read` turns the text typed after it into the value;
 * a switch, which takes no text, sets `value`.
 *
 * ```ts
 * import type { Flag } from './parse.ts';
 *
 * const width: Flag = { sets: 'width', read: Number };
 * ```
 */
export interface Flag {
  /** Where the value goes: an option, `pdf.<setting>`, the request's own fields, or nowhere. */
  sets:
    | keyof RecordOptions
    | `pdf.${keyof PdfOptions}`
    | 'help'
    | 'pdfHeaderFile'
    | 'pdfFooterFile'
    | null;
  /** Reads the flag's text into its value; a flag without one is a switch. */
  read?: (text: string) => unknown;
  /** What a switch sets. */
  value?: unknown;
  /** Repeatable: each use adds to a list (`read` returns the items one use adds). */
  list?: true;
}

// How a flag's text is read: a number, a number or a selector, a length, or a paper size.
// Text that is not a number is passed on as typed, so the rule it fails quotes what was typed.
const asNumber = (text: string): number | string =>
  text.trim() !== '' && Number.isFinite(Number(text)) ? Number(text) : text;
const asMsOrCSSSelector = (text: string): number | string =>
  /^\d+$/.test(text) ? Number(text) : text;
// A bare number is CSS pixels, as it is from the JS API.
const asCSSLength = (text: string): number | string =>
  /^\d+(\.\d+)?$/.test(text) ? Number(text) : text;
// A paper is a name, `fit`, or WIDTHxHEIGHT (`20cmx30cm`, `800x600`).
const asPaperDimensions = (text: string): unknown => {
  const sized = /^([\d.]+[a-z]*)x([\d.]+[a-z]*)$/i.exec(text);
  return sized ? { width: asCSSLength(sized[1]), height: asCSSLength(sized[2]) } : text;
};
const asFormatEntries = (text: string): string[] => Outputs.splitEntries([text]);

/**
 * Every flag `qunitx record` takes, by each of its spellings.
 *
 * ```ts
 * import { FLAGS } from './parse.ts';
 *
 * FLAGS['-w'].sets; // 'width'
 * ```
 */
export const FLAGS: Record<string, Flag> = {
  '--help': { sets: 'help', value: true },
  // Read straight off argv by the perf logger, as for every command.
  '--trace-perf': { sets: null, value: true },
  '-f': { sets: 'formats', read: asFormatEntries, list: true },
  '--format': { sets: 'formats', read: asFormatEntries, list: true },
  '-w': { sets: 'width', read: asNumber },
  '--width': { sets: 'width', read: asNumber },
  '-h': { sets: 'height', read: asNumber },
  '--height': { sets: 'height', read: asNumber },
  '-o': { sets: 'output', read: String },
  '--output': { sets: 'output', read: String },
  '--scale': { sets: 'scale', read: asNumber },
  '--full-page': { sets: 'fullPage', value: true },
  '--wait-for': { sets: 'waitFor', read: asMsOrCSSSelector },
  '--page-duration': { sets: 'pageDuration', read: asNumber },
  '--last-frame-duration': { sets: 'lastFrameDuration', read: asNumber },
  '--fps': { sets: 'fps', read: asNumber },
  '--quality': { sets: 'quality', read: asNumber },
  '--browser': { sets: 'browser', read: String },
  '--timeout': { sets: 'timeout', read: asNumber },
  '-p': { sets: 'port', read: asNumber },
  '--port': { sets: 'port', read: asNumber },
  '--pdf-paper': { sets: 'pdf.paper', read: asPaperDimensions },
  '--pdf-margin': { sets: 'pdf.margin', read: asCSSLength },
  '--pdf-scale': { sets: 'pdf.scale', read: asNumber },
  '--pdf-media': { sets: 'pdf.media', read: String },
  '--pdf-mode': { sets: 'pdf.mode', read: String },
  '--pdf-pages': { sets: 'pdf.pageRanges', read: String },
  '--pdf-landscape': { sets: 'pdf.landscape', value: true },
  '--pdf-outline': { sets: 'pdf.outline', value: true },
  '--no-pdf-background': { sets: 'pdf.background', value: false },
  '--pdf-header': { sets: 'pdfHeaderFile', read: String },
  '--pdf-footer': { sets: 'pdfFooterFile', read: String },
};

/**
 * An argument `qunitx record` will not accept.
 *
 * ```ts
 * import { InvalidRecordArgument } from './parse.ts';
 *
 * InvalidRecordArgument({ argument: '--width', reason: 'expected a whole number of pixels' }).message;
 * // 'qunitx record --width: expected a whole number of pixels'
 * ```
 */
export const InvalidRecordArgument: Failure.FailureFactory<
  'InvalidRecordArgument',
  { argument: string; reason: string }
> = Failure.define(
  'InvalidRecordArgument',
  (data: { argument: string; reason: string }) => `qunitx record ${data.argument}: ${data.reason}`,
);

/**
 * What `qunitx record` was asked to do, as its argv says.
 *
 * ```ts
 * const recordRequest: RecordRequest = { help: false, sources: ['https://example.com'], options: { width: 1200 } };
 * recordRequest.options.width; // 1200
 * ```
 */
export interface RecordRequest {
  /** `--help`: print usage and stop. */
  help: boolean;
  /** The inputs, as typed. */
  sources: string[];
  /** What the flags set. */
  options: RecordOptions;
  /** `--pdf-header` and `--pdf-footer`: HTML template files, read relative to where it runs. */
  pdfHeaderFile?: string;
  /** `--pdf-footer`, likewise. */
  pdfFooterFile?: string;
}

/**
 * Parses `qunitx record`'s arguments.
 *
 * A flag's value follows it (`-w 1200`) or is glued on with `=` (`--width=1200`). `-f` values
 * split on commas, and one ending in a comma continues into the next argument, so
 * `-f a.gif, a.jpg` works as typed. Everything else that does not start with `-` is an input, as
 * is all after `--`. Read in one pass; the first argument that will not do stops it.
 *
 * ```ts
 * import { InvalidRecordArgument, parse } from './parse.ts';
 *
 * const parsed = parse(['http://a.com', '-f', 'a.gif,', 'a.jpg', '-w', '1200', '-h', '800']);
 * if (!InvalidRecordArgument.is(parsed)) {
 *   parsed.sources; // ['http://a.com']
 *   parsed.options.formats; // ['a.gif', 'a.jpg']
 *   parsed.options.height; // 800
 * }
 * ```
 */
export function parse(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Result<RecordRequest, Failure.Of<typeof InvalidRecordArgument>> {
  const sources: string[] = [];
  let recordRequest: RecordRequest = { help: false, sources, options: {} };
  for (let index = 0, step = 1; index < argv.length; index += step) {
    const argument = argv[index];
    if (argument === '--') {
      sources.push(...argv.slice(index + 1));
      step = argv.length;
    } else if (!argument.startsWith('-') || argument === '-') {
      sources.push(argument);
      step = 1;
    } else {
      const { flag, text, length } = parseFlag(argv, index);
      // A value is quoted on its own when it will not do; a flag that takes none, as typed.
      const quoted = FLAGS[flag]?.read ? flag : argument;
      const applied = applyFlagToRecordRequest(recordRequest, flag, text, quoted);
      if (Failure.is(applied)) return applied;
      recordRequest = applied;
      step = length;
    }
  }
  // The default engine for every qunitx command, as for a test run: `--browser` wins over it.
  return env.QUNITX_BROWSER && recordRequest.options.browser === undefined
    ? applyFlagToRecordRequest(recordRequest, '--browser', env.QUNITX_BROWSER, 'QUNITX_BROWSER')
    : recordRequest;
}

// The flag at `argv[index]`, the text it takes (glued on with `=`, or the next argument for a flag
// that reads one), and how many arguments that was.
function parseFlag(
  argv: readonly string[],
  index: number,
): { flag: string; text?: string; length: number } {
  const argument = argv[index];
  const equals = argument.indexOf('=');
  if (equals !== -1) {
    return parseFlagsListValue(
      argument.slice(0, equals),
      argument.slice(equals + 1),
      argv,
      index + 1,
      1,
    );
  } else if (!FLAGS[argument]?.read || index + 1 === argv.length) {
    return { flag: argument, length: 1 };
  }
  return parseFlagsListValue(argument, argv[index + 1], argv, index + 2, 2);
}

// A comma-separated `-f` list the shell split at its spaces arrives in pieces: `-f a.gif, b.jpg` is
// `a.gif,` then `b.jpg`. The list goes on from `argv[next]` to the first argument not ending in a
// comma; `length` is how many arguments the flag took before it.
function parseFlagsListValue(
  flag: string,
  text: string,
  argv: readonly string[],
  next: number,
  length: number,
): { flag: string; text: string; length: number } {
  if (FLAGS[flag]?.sets !== 'formats' || !text.endsWith(',')) return { flag, text, length };
  const last = argv.findIndex((part, index) => index >= next && !part.endsWith(','));
  const end = last === -1 ? argv.length : last + 1;
  return { flag, text: [text, ...argv.slice(next, end)].join(''), length: length + end - next };
}

// The request with one flag applied, or why it will not do: a flag it does not know, a value
// missing, or one the JS API's rules refuse (see invalidOptionReason), a PDF setting along with
// the rest of `pdf`. `quoted` is what an error names.
function applyFlagToRecordRequest(
  recordRequest: RecordRequest,
  flag: string,
  text: string | undefined,
  quoted: string,
): RecordRequest | Failure.Of<typeof InvalidRecordArgument> {
  const known = FLAGS[flag];
  if (!known || (!known.read && text !== undefined)) {
    return InvalidRecordArgument({
      argument: quoted,
      reason: 'unknown flag (see qunitx record --help)',
    });
  } else if (known.read && text === undefined) {
    return InvalidRecordArgument({ argument: quoted, reason: 'needs a value' });
  }
  const { sets, read, value, list } = known;
  const parsed = read ? read(text as string) : value;
  if (sets === null) return recordRequest;
  else if (sets === 'help' || sets === 'pdfHeaderFile' || sets === 'pdfFooterFile') {
    return { ...recordRequest, [sets]: parsed };
  }
  const [option, setting] = sets.split('.') as [keyof RecordOptions, string?];
  const current = recordRequest.options[option];
  const next = setting
    ? { ...(current as object), [setting]: parsed }
    : list
      ? [...((current as unknown[]) ?? []), ...(parsed as unknown[])]
      : parsed;
  const problem = invalidOptionReason(option, next, setting || list ? undefined : `"${text}"`);
  return problem
    ? InvalidRecordArgument({ argument: quoted, reason: problem })
    : { ...recordRequest, options: { ...recordRequest.options, [option]: next } };
}
