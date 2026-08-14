import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Which install channel is running, decided from facts rather than guesses: `process.execPath`
// (the binary IS the install for a SEA / `deno compile` build, whereas node and deno report the
// runtime), this module's own path (which project, and which package manager, installed it), and
// the two cache layouts — the JSR launcher's version-keyed binary cache, and deno's module cache.
//
// Synchronous and cheap on purpose: at most a handful of `existsSync` calls, all behind the
// injectable `fileExists`, so every shape below is reachable in a test without that install
// existing on the machine.

// Both compiled flavours name the executable `qunitx`; the runtime channels name it node/deno.
const BINARY_NAMES = new Set(['qunitx', 'qunitx.exe']);
const SEMVER = /^\d+\.\d+\.\d+/;
const DENO_MANIFESTS = ['deno.json', 'deno.jsonc'];
const DENO_CACHE_LAYOUT =
  /[\\/](?:deno[\\/](?:npm|remote)|npm[\\/]registry\.npmjs\.org|remote[\\/]https)[\\/]/;

/**
 * The install channel this process is running from — the one thing `upgrade` must get right,
 * since only one of them can replace itself.
 *
 * ```ts
 * import * as Channel from './channel.ts';
 *
 * const channel: Channel.InstallChannel = Channel.detect({ execPath: '/home/u/.qunitx/qunitx' });
 * channel.kind; // 'standalone' — the only channel that owns its own binary
 * ```
 */
export type InstallChannel =
  /** A downloaded binary that owns its own path: `install.sh`, or a manual release download. */
  | { kind: 'standalone'; flavor: 'sea' | 'deno'; binaryPath: string }
  /** The JSR launcher's per-version binary cache under `~/.cache/qunitx/<version>/<target>/`. */
  | { kind: 'jsr-launcher'; binaryPath: string; version: string }
  /** `npm install -g qunitx-cli` — npm owns the files under its prefix. */
  | { kind: 'npm-global'; prefix: string }
  /** A project dependency installed by npm — `manifest` is the package.json that declares it. */
  | { kind: 'npm-local'; projectRoot: string; manifest: string }
  /** A project dependency installed by deno — `manifest` is its deno.json(c), or its package.json. */
  | { kind: 'deno-project'; projectRoot: string; manifest: string }
  /** `deno run npm:qunitx-cli` out of deno's module cache, where nothing is installed at all. */
  | { kind: 'deno-cache'; entry: string }
  /** A source checkout (`node cli.ts`, `deno run cli.ts`), where git is the updater. */
  | { kind: 'source'; entry: string };

/**
 * The observable state {@link detect} reads. Every field defaults to this process, and every
 * field is injectable so each channel is reachable in a test without that install existing.
 *
 * ```ts
 * import * as Channel from './channel.ts';
 *
 * const probe: Channel.ChannelProbe = { execPath: '/usr/bin/node', platform: 'linux' };
 * probe.platform; // 'linux' — path rules follow this, not the host
 * ```
 */
export interface ChannelProbe {
  /** `process.execPath`: the compiled binary itself, or the node/deno that is running it. */
  execPath?: string;
  /** Absolute path of a file inside the installed package — `undefined` inside a SEA bundle. */
  modulePath?: string;
  /** Path semantics to apply. Defaults to the host's. */
  platform?: NodeJS.Platform;
  /** Whether the Deno global is present, which is what separates a `deno compile` build from a SEA. */
  isDeno?: boolean;
  /** Existence probe for the only filesystem question asked: which manifest sits above the install. */
  fileExists?: (target: string) => boolean;
  /** An explicit `DENO_DIR`, which relocates the module cache off its recognisable path. */
  denoDir?: string;
}

/**
 * Resolves the channel this process is running from.
 *
 * ```ts
 * import * as Channel from './channel.ts';
 *
 * Channel.detect({ execPath: '/opt/qunitx/qunitx', isDeno: true }).kind; // 'standalone'
 * Channel.detect({ execPath: '/usr/bin/node', modulePath: '/app/lib/commands/upgrade/channel.ts' }).kind; // 'source'
 * ```
 */
export function detect(probe: ChannelProbe = {}): InstallChannel {
  const platform = probe.platform ?? process.platform;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const execPath = probe.execPath ?? process.execPath;
  const fileExists = probe.fileExists ?? existsSync;

  if (BINARY_NAMES.has(paths.basename(execPath).toLowerCase())) {
    // A compiled binary. It may still be a package manager's — `bin/qunitx.js` spawns the SEA out
    // of an optional platform package — so the node_modules question comes before ownership.
    const project = projectChannel(execPath, paths, fileExists);
    const cached = cachedVersion(paths.dirname(execPath), paths);
    if (project) return project;
    else if (cached) return { kind: 'jsr-launcher', binaryPath: execPath, version: cached };
    return {
      kind: 'standalone',
      flavor: (probe.isDeno ?? 'Deno' in globalThis) ? 'deno' : 'sea',
      binaryPath: execPath,
    };
  }

  // Running under node or deno: this module's own location is the install, not execPath.
  const modulePath = probe.modulePath ?? selfPath();
  const project = projectChannel(modulePath, paths, fileExists);
  const denoDir = probe.denoDir ?? process.env.DENO_DIR;
  if (project) return project;
  else if (inDenoCache(modulePath, denoDir)) return { kind: 'deno-cache', entry: modulePath };

  return { kind: 'source', entry: modulePath };
}

/**
 * The `npm install …@<version>` (or `deno add`, or `git pull`) line to print when the detected
 * channel cannot replace itself. One string, so every refusal stays comparable.
 *
 * `registry` only reaches the deno-project case, where the same dependency may be pinned through
 * either registry and the wrong `deno add` would add a second copy of it.
 *
 * ```ts
 * import * as Channel from './channel.ts';
 *
 * Channel.updateCommand({ kind: 'npm-global', prefix: '/usr/lib' }, '1.0.0'); // 'npm install -g qunitx-cli@1.0.0'
 * Channel.updateCommand({ kind: 'deno-cache', entry: '/c/deno/npm/x' }, '1.0.0'); // 'deno run -A npm:qunitx-cli@1.0.0'
 * ```
 */
export function updateCommand(
  channel: InstallChannel,
  version: string,
  registry: 'npm' | 'jsr' = 'npm',
): string {
  if (channel.kind === 'npm-global') return `npm install -g qunitx-cli@${version}`;
  else if (channel.kind === 'npm-local') return `npm install --save-dev qunitx-cli@${version}`;
  else if (channel.kind === 'deno-project') {
    return registry === 'jsr'
      ? `deno add jsr:@izelnakri/qunitx-cli@${version}`
      : `deno add npm:qunitx-cli@${version}`;
  } else if (channel.kind === 'deno-cache') return `deno run -A npm:qunitx-cli@${version}`;
  else if (channel.kind === 'jsr-launcher') {
    return `deno install -Agf jsr:@izelnakri/qunitx-cli@${version}`;
  } else if (channel.kind === 'source') return 'git pull';

  return `qunitx upgrade ${version}`;
}

// Which project a node_modules install belongs to, read from the OUTERMOST node_modules on the
// path: pnpm's real install lives at `node_modules/.pnpm/qunitx-cli@x/node_modules/qunitx-cli`,
// whose nearest node_modules has no project above it — the outermost one does.
//
// The order below matters. `node_modules/.deno/` is deno's own nodeModulesDir layout and nothing
// else produces it, so it settles the question for free, before any manifest is consulted. Only
// then does the manifest decide: a package.json means npm, a deno.json means deno, and neither
// means a global npm prefix (`/usr/lib/node_modules`, `%APPDATA%\npm\node_modules`), which is the
// one shape with no project above it at all.
function projectChannel(
  target: string,
  paths: typeof path.posix,
  fileExists: (target: string) => boolean,
): InstallChannel | null {
  const segments = target.split(/[\\/]/);
  const index = segments.indexOf('node_modules');
  if (index === -1) return null;

  const owner = segments.slice(0, index).join(paths.sep) || paths.sep;
  const packageJson = paths.join(owner, 'package.json');
  const denoManifest = DENO_MANIFESTS.map((name) => paths.join(owner, name)).find(fileExists);

  if (segments[index + 1] === '.deno') {
    return { kind: 'deno-project', projectRoot: owner, manifest: denoManifest ?? packageJson };
  } else if (fileExists(packageJson)) {
    return { kind: 'npm-local', projectRoot: owner, manifest: packageJson };
  } else if (denoManifest) {
    return { kind: 'deno-project', projectRoot: owner, manifest: denoManifest };
  }

  return { kind: 'npm-global', prefix: owner };
}

// Deno's module cache — `deno run npm:qunitx-cli`, where nothing is installed anywhere. Matched on
// the cache's own layout (`<DENO_DIR>/npm/<registry>/…`, `<DENO_DIR>/remote/https/…`) plus an
// explicit DENO_DIR when one is set, since that moves the whole tree somewhere unrecognisable.
function inDenoCache(target: string, denoDir: string | undefined): boolean {
  return (
    (denoDir !== undefined && denoDir !== '' && target.startsWith(denoDir)) ||
    DENO_CACHE_LAYOUT.test(target)
  );
}

// `<cache root>/qunitx/<version>/<os>-<arch>/qunitx` — the layout jsr/cli.ts writes. Recognised
// by shape rather than by rebuilding the root, because XDG_CACHE_HOME and LOCALAPPDATA move it.
function cachedVersion(dir: string, paths: typeof path.posix): string | null {
  const platformKey = paths.basename(dir);
  const version = paths.basename(paths.dirname(dir));
  const owner = paths.basename(paths.dirname(paths.dirname(dir)));

  return owner === 'qunitx' && SEMVER.test(version) && platformKey.includes('-') ? version : null;
}

// esbuild empties `import.meta` when it bundles the SEA's CJS entry, so this is undefined there.
// That path always answers the execPath question first, so the fallback is never load-bearing.
function selfPath(): string {
  const url: string | undefined = import.meta.url;

  return url ? fileURLToPath(url) : '';
}
