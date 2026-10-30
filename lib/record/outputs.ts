import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as Failure from '../result/failure.ts';
import * as Result from '../result/result.ts';
import type { Input } from './inputs.ts';
import type { RecordedFile } from './index.ts';

// Every spelling `-f` accepts, by what it produces. `jpg` and `jpeg` are one format.
const FORMATS: Record<string, Format> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  webm: 'webm',
  mp4: 'mp4',
  pdf: 'pdf',
};

/**
 * What a recording can be written as. `png` and `jpeg` are stills, one per input, and `pdf` a
 * document of each; `gif`, `webm` and `mp4` are animations of every input in turn.
 *
 * ```ts
 * const format: Format = 'gif';
 * ```
 */
export type Format = 'png' | 'jpeg' | 'gif' | 'webm' | 'mp4' | 'pdf';

/**
 * Whether a format is an animation of every input rather than a still of one.
 *
 * ```ts
 * import { isAnimated } from './outputs.ts';
 *
 * isAnimated('mp4'); // true
 * isAnimated('png'); // false
 * ```
 */
export function isAnimated(format: Format): boolean {
  return format === 'gif' || format === 'webm' || format === 'mp4';
}

/**
 * A `-f` entry that is neither a format nor a file name ending in one.
 *
 * ```ts
 * import { UnknownFormat } from './outputs.ts';
 *
 * UnknownFormat({ entry: 'bmp' }).message.startsWith('unknown format: bmp'); // true
 * ```
 */
export const UnknownFormat: Failure.FailureFactory<'UnknownFormat', { entry: string }> =
  Failure.define(
    'UnknownFormat',
    (data: { entry: string }) =>
      `unknown format: ${data.entry}. Expected png, jpg, gif, webm, mp4 or pdf, or a file name ending in one (-f home.png).`,
  );

/**
 * One file `qunitx record` will write.
 *
 * ```ts
 * const output: Output = { format: 'jpeg', absolutePath: '/shots/home.jpg', inputIndex: 0 };
 * output.inputIndex; // 0 — a still of the first input; null would mean an animation of all of them
 * ```
 */
export interface Output {
  /** What to write it as. */
  format: Format;
  /** Where it is written. */
  absolutePath: string;
  /** The position of the input a still is of, or `null` for an animation of every input. */
  inputIndex: number | null;
}

/**
 * Splits `-f` values into entries: each a format (`gif`) or a file name ending in one
 * (`home.gif`). Commas separate them, and a value that ended in a comma continues into the next
 * argument, so `-f home.gif, home.jpg` reads the way it was typed.
 *
 * ```ts
 * import { splitEntries } from './outputs.ts';
 *
 * splitEntries(['gif,jpg']); // ['gif', 'jpg']
 * splitEntries(['home.gif,', 'home.jpg']); // ['home.gif', 'home.jpg']
 * ```
 */
export function splitEntries(values: string[]): string[] {
  return values
    .flatMap((value) => value.split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * The files to write: one or more for each `-f` entry, in the order they were asked for.
 *
 * `outputEntries` is what `-f` asked for, each a format (`gif`) or a file name ending in one
 * (`home.gif`); `inputs` is what is being recorded. With no entries, a single page is a `.jpg`,
 * and anything that moves (two or more inputs, or a script) is a `.jpg` of each input plus one
 * `.gif` of them all. A bare format is named after its input, or `recording.gif` when it covers
 * several; a file name is used as given, and a still of several inputs numbers them. Every path
 * is in `outputDir`.
 *
 * ```ts
 * import { plan, UnknownFormat } from './outputs.ts';
 *
 * const page = (name: string) => ({ kind: 'url' as const, source: name, url: `https://${name}`, name });
 * const pages = [page('a.com'), page('b.com')];
 * const files = (outputEntries: string[]) => {
 *   const outputs = plan(outputEntries, pages, '/shots');
 *   return UnknownFormat.is(outputs) ? [] : outputs.map((output) => output.absolutePath);
 * };
 *
 * files([]); // ['/shots/a.com.jpg', '/shots/b.com.jpg', '/shots/recording.gif']
 * files(['home.png', 'gif']); // ['/shots/home-1.png', '/shots/home-2.png', '/shots/recording.gif']
 * UnknownFormat.is(plan(['bmp'], pages, '/shots')); // true
 * ```
 */
export function plan(
  outputEntries: string[],
  inputs: Input[],
  outputDir: string,
): Output[] | Failure.Of<typeof UnknownFormat> {
  const entries = outputEntries.length ? outputEntries : defaultEntries(inputs);
  const { values: requests, errors: unknown } = Result.partition(entries.map(parseEntry));
  if (unknown.length) return unknown[0];

  return requests.flatMap(({ format, fileName }): Output[] => {
    const extension = fileName ? path.extname(fileName) : `.${extensionOf(format)}`;
    if (isAnimated(format)) {
      const absolutePath = path.resolve(
        outputDir,
        makeAnimationFileName(fileName, extension, inputs),
      );
      return [{ format, absolutePath, inputIndex: null }];
    }
    return makeStaticMediaFileNames(fileName, extension, inputs).map((name, inputIndex) => ({
      format,
      absolutePath: path.resolve(outputDir, name),
      inputIndex,
    }));
  });
}

/**
 * Writes `bytes` where `output` goes, and describes the file written. Its directory is made before
 * a recording starts, so this is one write.
 *
 * ```ts
 * import * as Outputs from './outputs.ts';
 *
 * // Defined, not invoked: writes a file.
 * async function save(bytes: Uint8Array) {
 *   const output = { format: 'png' as const, absolutePath: '/shots/home.png', inputIndex: 0 };
 *   return (await Outputs.write(output, bytes, { width: 40, height: 30, frames: 1 })).bytes;
 * }
 * ```
 */
export async function write(
  output: Output,
  bytes: Uint8Array,
  contents: Pick<RecordedFile, 'width' | 'height' | 'frames'>,
): Promise<RecordedFile> {
  await writeFile(output.absolutePath, bytes);
  return { path: output.absolutePath, format: output.format, ...contents, bytes: bytes.length };
}

// A single page is a still; anything that moves (two or more inputs, or a script) adds a GIF.
function defaultEntries(inputs: Input[]): string[] {
  const moves = inputs.length > 1 || inputs.some((input) => input.kind === 'script');
  return moves ? ['jpg', 'gif'] : ['jpg'];
}

// What an entry asks for: a bare format (`gif`), or a file name ending in one (`home.gif`).
function parseEntry(
  entry: string,
): { format: Format; fileName: string | null } | Failure.Of<typeof UnknownFormat> {
  const bare = FORMATS[entry.toLowerCase()];
  if (bare) return { format: bare, fileName: null };

  const format = FORMATS[path.extname(entry).slice(1).toLowerCase()];
  return format && path.basename(entry, path.extname(entry))
    ? { format, fileName: entry }
    : UnknownFormat({ entry });
}

// One animation of every input: `fileName` as given, or named after its input when there is only
// one.
function makeAnimationFileName(
  fileName: string | null,
  extension: string,
  inputs: Input[],
): string {
  return fileName ?? (inputs.length === 1 ? inputs[0].name : 'recording') + extension;
}

// One still per input: named after each input, or after `fileName`, numbered when there are
// several inputs.
function makeStaticMediaFileNames(
  fileName: string | null,
  extension: string,
  inputs: Input[],
): string[] {
  if (!fileName) {
    return makeFileNamesUnique(inputs.map((input) => input.name)).map((name) => name + extension);
  } else if (inputs.length === 1) return [fileName];
  const stem = fileName.slice(0, -extension.length);
  return inputs.map((_input, index) => `${stem}-${index + 1}${extension}`);
}

function extensionOf(format: Format): string {
  return format === 'jpeg' ? 'jpg' : format;
}

// Two inputs that would share a default name get `-2`, `-3`… rather than overwriting each other.
function makeFileNamesUnique(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name}-${count}`;
  });
}
