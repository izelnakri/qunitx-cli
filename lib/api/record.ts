import process from 'node:process';
import * as Record from '../record/index.ts';
import * as Failure from '../result/failure.ts';
import { Task } from '../task/index.ts';
import type { RecordResult } from '../record/index.ts';
import * as Config from '../record/config.ts';

export type {
  RecordedFile,
  RecordOptions,
  RecordResult,
  SnapshotComparison,
} from '../record/index.ts';

/**
 * Every way {@link record} can reject: an input that is not there or not recordable, a format it
 * cannot write, `compare` asked of something that is not a png still, or an option outside what
 * `qunitx record` itself would accept. A page that fails to load rejects with the browser's own
 * error.
 *
 * ```ts
 * import { UnrecordableInput } from '../record/index.ts';
 *
 * const failure: RecordFailure = UnrecordableInput({ input: 'a.txt', reason: 'not a page' });
 * failure.code; // 'UnrecordableInput'
 * ```
 */
export type RecordFailure = Failure.Of<
  | typeof Record.UnrecordableInput
  | typeof Record.UnknownFormat
  | typeof Record.CompareNeedsPng
  | typeof Record.InvalidRecordOption
  | typeof Config.InvalidRecordConfig
>;

/**
 * Screenshots and GIFs of pages, URLs and scripts, taken in a real browser — the API twin of
 * `qunitx record`. Resolves with the files it wrote.
 *
 * Like the command, it starts from `package.json#qunitx.record`: options given win setting by
 * setting, inputs given replace the configured ones, and with none given the configured inputs
 * are recorded.
 *
 * **A script that exits non-zero is a result, not a rejection** — `ok: false`, its files written
 * all the same, the way a red suite is a result for `test()`.
 *
 * ```ts
 * import { record } from './record.ts';
 *
 * // Defined, not invoked: launches a browser and writes files.
 * async function shoot() {
 *   const result = await record(['https://example.com', 'docs/index.html'], {
 *     formats: ['png', 'tour.gif'],
 *     width: 1200,
 *     output: 'screenshots',
 *   });
 *   return result.files.map((file) => file.path); // […/example.com.png, …/docs.png, …/tour.gif]
 * }
 * ```
 */
export function record(
  inputs: string | string[] = [],
  options: Record.RecordOptions = {},
): Task<RecordResult, RecordFailure> {
  return Task(async () => {
    const config = await Config.read(options.cwd ?? process.cwd());
    if (Failure.is(config)) throw config;
    // One input, or a list of them.
    const inputsGiven = [inputs].flat();
    // As the command does: options given win, `pdf` field by field.
    return await Record.record(inputsGiven.length ? inputsGiven : config.inputs, {
      ...config.options,
      ...options,
      pdf: { ...config.options.pdf, ...options.pdf },
    });
  });
}
