import path from 'node:path';
import * as Channel from '../upgrade/channel.ts';

// What `qunitx uninstall` would do, worked out before anything is touched.
//
// The same six channels `upgrade` knows, asked the opposite question. Two of them qunitx owns and
// can remove itself; two are owned by a package manager, which is asked to do it; two are not
// installs at all, and saying so is the whole answer.
//
// Pure: every path here is a CANDIDATE, and the caller removes the ones that exist. That keeps the
// decision testable without a real install, and keeps a plan honest on a machine where the sidecar
// was never there.

/**
 * The per-OS cache root the JSR launcher writes its binaries under — `jsr/cli.ts` picks the same.
 *
 * ```ts
 * import { cacheRootFor } from './plan.ts';
 *
 * cacheRootFor({ HOME: '/home/u' }, 'linux'); // '/home/u/.cache/qunitx'
 * cacheRootFor({ XDG_CACHE_HOME: '/tmp/c' }, 'linux'); // '/tmp/c/qunitx'
 * cacheRootFor({}, 'linux'); // null — no home, so no guess at one
 * ```
 */
export function cacheRootFor(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string | null {
  const home = env.HOME ?? env.USERPROFILE;
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? (home ? path.win32.join(home, 'AppData', 'Local') : null);

    return local ? path.win32.join(local, 'qunitx') : null;
  }
  const base = env.XDG_CACHE_HOME ?? (home ? path.posix.join(home, '.cache') : null);

  return base ? path.posix.join(base, 'qunitx') : null;
}

/**
 * What an uninstall of this install would be.
 *
 * `remove` — qunitx owns these files and deletes them. `run` — a package manager owns them and is
 * asked to. `refuse` — removing it is someone else's decision, and the command to make it is
 * printed. `nothing` — this was never an install.
 *
 * ```ts
 * import type { UninstallPlan } from './plan.ts';
 *
 * const plan: UninstallPlan = { kind: 'nothing', removals: [], argv: null, why: 'nothing was installed' };
 * plan.kind; // 'nothing'
 * ```
 */
export interface UninstallPlan {
  /** What this uninstall is: files to delete, a command to run, a refusal, or nothing to do. */
  kind: 'remove' | 'run' | 'refuse' | 'nothing';
  /** Absolute paths to delete, in order. Candidates: the caller skips what is not there. */
  removals: string[];
  /** The owner's uninstaller — run for `run`, printed for `refuse`. */
  argv: string[] | null;
  /** Why, in one sentence, for the two kinds that do not remove anything. */
  why: string;
  /** The manifest a project dependency is declared in, for `--write-manifest`. */
  manifest?: string;
}

/**
 * The plan for one channel.
 *
 * ```ts
 * import { planFor } from './plan.ts';
 *
 * planFor({ kind: 'npm-global', prefix: '/usr/lib' }, {}, 'linux').argv;
 * // ['npm', 'uninstall', '-g', 'qunitx-cli']
 * planFor({ kind: 'source', entry: '/repo/cli.ts' }, {}, 'linux').kind; // 'refuse'
 * ```
 */
export function planFor(
  channel: Channel.InstallChannel,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  registry: 'npm' | 'jsr' = 'npm',
): UninstallPlan {
  const caches = cacheRootFor(env, platform);

  if (channel.kind === 'standalone') {
    return {
      kind: 'remove',
      // The binary, the esbuild that travels with it, and the musl build's own directory — the
      // three things `install.sh` puts there. Its `lib/` and `node_modules/` live inside that
      // directory, so removing it takes them along.
      removals: besideTheBinary(channel.binaryPath, platform),
      argv: null,
      why: '',
    };
  } else if (channel.kind === 'jsr-launcher') {
    // deno owns the shim it wrote into its own bin; the cached binaries under this are ours.
    return {
      kind: 'run',
      removals: caches ? [caches] : [],
      argv: ['deno', 'uninstall', '-g', 'qunitx-cli'],
      why: '',
    };
  } else if (channel.kind === 'npm-global') {
    return { kind: 'run', removals: [], argv: ['npm', 'uninstall', '-g', 'qunitx-cli'], why: '' };
  } else if (channel.kind === 'npm-local') {
    return {
      kind: 'refuse',
      removals: [],
      argv: ['npm', 'uninstall', '--save-dev', 'qunitx-cli'],
      why: `qunitx is a devDependency of ${channel.projectRoot}; removing it is a change to that project, so this command will not make it for you.`,
      manifest: channel.manifest,
    };
  } else if (channel.kind === 'deno-project') {
    return {
      kind: 'refuse',
      removals: [],
      argv: ['deno', 'remove', registry === 'jsr' ? 'jsr:@izelnakri/qunitx-cli' : 'npm:qunitx-cli'],
      why: `qunitx is a dependency of ${channel.projectRoot}; removing it is a change to that project, so this command will not make it for you.`,
      manifest: channel.manifest,
    };
  } else if (channel.kind === 'deno-cache') {
    return {
      kind: 'nothing',
      removals: [],
      argv: null,
      why: 'this ran straight out of deno’s module cache, so nothing was installed to remove — `deno clean` empties that cache, and it is deno’s, not qunitx’s.',
    };
  }

  return {
    kind: 'refuse',
    removals: [],
    argv: null,
    why: `this qunitx is running from a source checkout (${channel.entry}) — deleting a working tree is not a command qunitx should run, and \`git\` is what owns it.`,
  };
}

/**
 * Everything `install.sh` leaves beside a standalone binary, as candidates.
 *
 * The binary, both spellings of the esbuild sidecar, and `qunitx-musl/` — the directory the musl
 * build is unpacked into, with `qunitx` linked to it. A glibc install has no such directory and a
 * musl one has no loose sidecar; the caller removes whichever are there.
 *
 * ```ts
 * import { besideTheBinary } from './plan.ts';
 *
 * besideTheBinary('/home/u/.qunitx/qunitx', 'linux');
 * // ['/home/u/.qunitx/qunitx', '/home/u/.qunitx/esbuild', '/home/u/.qunitx/qunitx-musl']
 * ```
 */
export function besideTheBinary(binaryPath: string, platform: NodeJS.Platform): string[] {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const directory = paths.dirname(binaryPath);
  const sidecar = platform === 'win32' ? 'esbuild.exe' : 'esbuild';

  return [binaryPath, paths.join(directory, sidecar), paths.join(directory, 'qunitx-musl')];
}
