import fs from 'node:fs/promises';
import { Task } from '../task/index.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reads a template file by relative path. Two runtimes to satisfy:
 *  - Node SEA binary: assets live in the SEA store (node:sea).
 *  - Node / Deno (source, npm, or `deno compile` binary): plain fs.readFile —
 *    Deno's node:fs compat reads `--include`d files from the compiled VFS too
 *    (verified on Deno 2.9.2; earlier versions rejected it, needing Deno.readFile).
 *
 * The two `__dirname`-relative bases cover (a) running from source where
 * templates are 2 levels above lib/utils/, and (b) running from the bundled
 * dist/ where __dirname is the package root so templates are only 1 level up.
 *
 * ```ts
 * // Defined, not invoked: reads template files from the package directory (or the SEA store).
 * async function loadRunnerHtml(): Promise<string> {
 *   return await readTemplate('test-runner.html'); // throws when the asset is missing entirely
 * }
 * ```
 */
export async function readTemplate(relativePath: string): Promise<string> {
  const sea = await import('node:sea').catch(() => null);
  if (sea?.isSea()) return sea.getAsset(relativePath, 'utf8');
  const __dirname = dirname(fileURLToPath(import.meta.url));

  // "the first candidate that resolves", said once, instead of a loop whose empty catch is the
  // only thing expressing "try the next one". Both layouts are read concurrently — they are two
  // small file reads, once per invocation.
  return await Task.any(
    ['../templates', '../../templates'].map((base) =>
      Task(() => fs.readFile(join(__dirname, base, relativePath))),
    ),
  )
    .map((contents) => contents.toString())
    .mapErr(
      () =>
        new Error(
          `qunitx-cli: template "${relativePath}" not found — try reinstalling the package.`,
        ),
    );
}
