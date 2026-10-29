import fs from 'node:fs/promises';
import path from 'node:path';
import { Failure } from '../result/index.ts';
import { findProjectRoot } from '../utils/find-project-root.ts';
import { invalidOptionReason, isOption } from './options.ts';
import type { RecordOptions } from './index.ts';

// Options package.json may not set, though they are options: `update` there would accept every
// change on every run, CI's included, and `cwd` is wherever the command is run.
const NOT_IN_PACKAGE_JSON = ['update', 'cwd'];

/**
 * A `package.json#qunitx.record` setting `qunitx record` will not accept.
 *
 * ```ts
 * import { InvalidRecordConfig } from './config.ts';
 *
 * InvalidRecordConfig({ setting: 'update', reason: 'is not a setting' }).message;
 * // 'package.json#qunitx.record.update: is not a setting'
 * ```
 */
export const InvalidRecordConfig: Failure.FailureFactory<
  'InvalidRecordConfig',
  { setting: string | null; reason: string }
> = Failure.define(
  'InvalidRecordConfig',
  (data: { setting: string | null; reason: string }) =>
    `package.json#qunitx.record${data.setting ? `.${data.setting}` : ''}: ${data.reason}`,
);

/**
 * `package.json#qunitx.record` of the project around `cwd`: its `inputs`, and every other setting
 * as the option of the same name, held to the rules the command line and the JS API are. Relative
 * inputs and `output` are relative to the package.json, wherever the command is run from. Nothing
 * when there is no package.json or no `qunitx.record` in it.
 *
 * ```ts
 * import * as Config from './config.ts';
 *
 * // Defined, not invoked: reads the package.json above `cwd`.
 * async function configured(cwd: string) {
 *   return await Config.read(cwd); // { inputs: ['/app/pages/home.html'], options: { width: 1280, … } }
 * }
 * ```
 */
export async function read(
  cwd: string,
): Promise<{ inputs: string[]; options: RecordOptions } | Failure.Of<typeof InvalidRecordConfig>> {
  const nothing = { inputs: [], options: {} };
  const root = await findProjectRoot(cwd).result();
  if (Failure.is(root)) return nothing;
  const manifest: { qunitx?: { record?: unknown } } | null = await fs
    .readFile(path.join(root, 'package.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => null);
  const settings = manifest?.qunitx?.record;
  if (settings === undefined) return nothing;
  else if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return InvalidRecordConfig({ setting: null, reason: 'must be an object' });
  }
  const { inputs = [], ...options } = settings as Record<string, unknown>;
  if (!Array.isArray(inputs) || !inputs.every((input) => typeof input === 'string')) {
    return InvalidRecordConfig({ setting: 'inputs', reason: 'must be a list of strings' });
  }
  for (const [setting, value] of Object.entries(options)) {
    const reason = refusalOf(setting, value);
    if (reason) return InvalidRecordConfig({ setting, reason });
  }
  // A URL is where it is; anything else is a path from the package.json.
  const convertToAbsolutePath = (file: string) =>
    /^[a-z]+:\/\//i.test(file) ? file : path.resolve(root, file);
  // A path by its rule, checked above.
  if (options.output) options.output = convertToAbsolutePath(options.output as string);
  return { inputs: inputs.map(convertToAbsolutePath), options: options as RecordOptions };
}

// Why `setting` will not do in package.json, or null when it will.
function refusalOf(setting: string, value: unknown): string | null {
  return NOT_IN_PACKAGE_JSON.includes(setting) || !isOption(setting)
    ? 'is not a setting qunitx record understands (see qunitx record --help)'
    : invalidOptionReason(setting, value);
}
