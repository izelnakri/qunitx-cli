import { spawnSync } from 'node:child_process';
import { RUNTIMES } from '../../lib/setup/targets.ts';
import type { RuntimeName } from '../../lib/setup/targets.ts';

/**
 * The runtimes this machine can actually start.
 *
 * `deno` is not a hard dependency of working on this package — it is a lane in CI and an optional
 * target for the prompt — so where it is missing the answer is to test the ones that ARE here
 * rather than to fail somebody who never asked for it. This is why every test lane went red the
 * first time: the file said it skipped a missing runtime and then iterated the list regardless.
 *
 * Asked once, synchronously, at module load: `--version` is cheap and the alternative is the same
 * question inside every test.
 *
 * ```ts
 * import { installedRuntimes } from './installed-runtimes.ts';
 *
 * installedRuntimes().includes('node'); // true — this is running on one
 * ```
 */
export function installedRuntimes(): RuntimeName[] {
  return RUNTIMES.filter(
    (runtime) => spawnSync(runtime, ['--version'], { stdio: 'ignore' }).status === 0,
  );
}
