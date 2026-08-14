import { basename } from 'node:path';
import { blue, magenta } from '../../utils/color.ts';
import { processConsole, type Console } from '../../console.ts';
import { Failure, type Result } from '../../result/index.ts';
import * as Channel from './channel.ts';
import * as Install from './install.ts';
import * as Manifest from './manifest.ts';
import * as Release from './release.ts';
import pkg from '../../../package.json' with { type: 'json' };

// `qunitx upgrade`. Six install channels reach this code and only one of them owns the file it is
// running from, so the command's real job is deciding which — and refusing, with the exact command
// to run instead, in every case where replacing anything would be someone else's call. See
// channel.ts for how each is recognised.

const highlight = (text: string): string => magenta().bold(text);
const color = (text: string): string => blue(text);
const VERSION_ARGUMENT = /^v?\d+\.\d+\.\d+/;

const USAGE = `${highlight(`[qunitx v${pkg.version}] Usage:`)} qunitx ${color('upgrade [version] [--check]')}

${highlight('Examples:')}
${color('$ qunitx upgrade')}                  # install the latest release over this one
${color('$ qunitx upgrade 0.34.2')}           # install that version instead (${color('v0.34.2')} and ${color('--version=')} work too)
${color('$ qunitx upgrade --check')}          # report only; exit 1 when a newer version exists
${color('$ qunitx upgrade --force')}          # re-download and replace even when already current

${highlight('Flags:')}
${color('--check')}               : print what an upgrade would do and exit without touching anything
${color('--force')}               : replace the binary even when it is already the requested version
${color('--write-manifest')}      : project dependency only — bump the range in package.json or deno.json (you run the install)

${highlight('What it does per install:')}
- standalone binary (${color('install.sh')}) : downloads the release, verifies its sha256, replaces itself
- ${color('npm')} (global or devDependency)  : refuses, and prints the ${color('npm install')} line to run
- ${color('deno')} project dependency        : refuses, and prints the ${color('deno add')} line for how it is pinned
- ${color('deno install')} from JSR          : refuses (the cache is version-keyed), prints the ${color('deno install')} line
- ${color('deno run npm:qunitx-cli')}        : nothing is installed to upgrade — pin the version in the command
- source checkout                : refuses — ${color('git')} is the updater there

${highlight('Exit codes:')} ${color('0')} up to date or upgraded, ${color('1')} not upgraded (newer version available, or this install updates another way), ${color('2')} could not check or install.
`;

/**
 * An argument this command will not accept.
 *
 * ```ts
 * import * as Upgrade from './index.ts';
 *
 * Upgrade.InvalidArgument({ argument: '--yolo' }).message; // 'Unknown qunitx upgrade argument: --yolo'
 * ```
 */
export const InvalidArgument: Failure.FailureFactory<
  'InvalidUpgradeArgument',
  { argument: string }
> = Failure.define(
  'InvalidUpgradeArgument',
  (data: { argument: string }) => `Unknown qunitx upgrade argument: ${data.argument}`,
);

/**
 * What `qunitx upgrade`'s argv asked for.
 *
 * ```ts
 * import type { UpgradeOptions } from './index.ts';
 *
 * const options: UpgradeOptions = { check: true, force: false, writeManifest: false, help: false };
 * options.check; // true — report, change nothing
 * ```
 */
export interface UpgradeOptions {
  /** Report only: no download, no replace. */
  check: boolean;
  /** Replace even when the requested version is the one already running. */
  force: boolean;
  /** Print usage and stop. */
  help: boolean;
  /** Bump the declared range in the project's manifest instead of refusing outright. */
  writeManifest: boolean;
  /** The pinned version, without its `v`. Absent means "the latest release". */
  version?: string;
}

/**
 * The seams `run` reaches the world through: the channel it believes it is, the release lookup,
 * the installer, and where its text goes. Every one defaults to the real thing.
 *
 * ```ts
 * import type { UpgradeDeps } from './index.ts';
 *
 * const deps: UpgradeDeps = { channel: { kind: 'source', entry: '/repo/cli.ts' } };
 * deps.channel?.kind; // 'source' — refuses without a single network call
 * ```
 */
export interface UpgradeDeps {
  /** Where the command's output goes. Defaults to the process streams. */
  console?: Console;
  /** The install channel. Defaults to {@link Channel.detect}. */
  channel?: Channel.InstallChannel;
  /** The version considered installed. Defaults to this package's. */
  currentVersion?: string;
  /** The release lookup. Defaults to {@link Release.find}. */
  find?: (version?: string) => Promise<Release.Release>;
  /** The installer. Defaults to {@link Install.apply}. */
  apply?: (plan: Install.InstallPlan) => Promise<string[]>;
  /** Platform used for asset selection. Defaults to the host's. */
  platform?: NodeJS.Platform;
  /** Architecture used for asset selection. Defaults to the host's. */
  arch?: string;
}

/**
 * Runs `qunitx upgrade`.
 *
 * ```ts
 * import * as Upgrade from './index.ts';
 *
 * // Defined, not invoked: reaches GitHub Releases and may replace the running binary.
 * async function upgradeCommand(): Promise<number> {
 *   return await Upgrade.run(); // 0 up to date · 1 stale · 2 could not check
 * }
 * ```
 *
 * @returns the process exit code.
 */
export async function run(
  argv: string[] = process.argv.slice(3),
  deps: UpgradeDeps = {},
): Promise<number> {
  const out = deps.console ?? processConsole;
  const options = parseArgs(argv);
  if (Failure.is(options)) {
    out.error(`${Failure.format(options)}\n\n`);
    out.error(USAGE);
    return 2;
  } else if (options.help) {
    out.log(USAGE);
    return 0;
  }

  const channel = deps.channel ?? Channel.detect();
  const current = deps.currentVersion ?? pkg.version;

  // The one channel whose answer does not depend on the release line: `git pull` is the same
  // sentence at every version, so an offline checkout gets the real reason rather than a
  // network error. Every other channel names a version, so it has to look one up first.
  if (channel.kind === 'source' && !options.check) {
    out.log(`${refusal(channel, current)}\n  ${color(Channel.updateCommand(channel, current))}\n`);
    return 1;
  }

  const release = await (deps.find ?? Release.find)(options.version).catch((error: unknown) => {
    out.error(`${Failure.format(error)}\n`);
    return null;
  });
  if (!release) return 2;

  const target = release.version;
  const ordering = Release.compare(target, current);
  // Read here, where the code is already async, rather than inside the synchronous `detect()`:
  // a deno project may pin the same dependency through either registry, and naming the wrong one
  // makes `deno add` add a second copy of it beside the first.
  const command = color(
    Channel.updateCommand(
      channel,
      target,
      channel.kind === 'deno-project' ? await Manifest.registry(channel.manifest) : 'npm',
    ),
  );

  if (options.check) {
    if (ordering <= 0) {
      out.log(`qunitx ${current} is up to date.\n`);
      return 0;
    }
    out.log(`A newer qunitx is available: ${current} → ${target}\n  ${command}\n`);
    return 1;
  } else if (ordering === 0 && !options.force) {
    out.log(`qunitx ${current} is already the latest version.\n`);
    return 0;
  } else if (ordering < 0 && !options.version) {
    // A dev build ahead of the release line: nothing to install, and no reason to say "stale".
    out.log(`qunitx ${current} is newer than the latest release (${target}) — nothing to do.\n`);
    return 0;
  } else if (options.writeManifest) {
    // One flag rather than one per manifest: which file declares the dependency is a fact about
    // the project, and `detect` already established it. The user should not have to know.
    if (channel.kind !== 'npm-local' && channel.kind !== 'deno-project') {
      out.error(
        `--write-manifest only applies to a project dependency, and this qunitx is ${describe(channel)}.\n`,
      );
      return 2;
    }
    const bumped = await Manifest.bump(channel.manifest, target).catch((error: unknown) => {
      out.error(`${Failure.format(error)}\n`);
      return null;
    });
    if (!bumped) return 2;
    out.log(`${channel.manifest}: ${bumped.field}.qunitx-cli → ${bumped.range}\n`);
    out.log(
      `Run ${color(channel.kind === 'npm-local' ? 'npm install' : 'deno install')} to fetch it.\n`,
    );
    return 0;
  } else if (channel.kind !== 'standalone') {
    out.log(`${refusal(channel, current)}\n  ${command}\n`);
    if (channel.kind === 'npm-local' || channel.kind === 'deno-project') {
      out.log(
        `  ${color('qunitx upgrade --write-manifest')} bumps the range in ${basename(channel.manifest)} instead.\n`,
      );
    }
    return 1;
  }

  const assetName = Release.assetName(channel.flavor, deps.platform, deps.arch);
  if (!assetName) {
    out.error(
      `No prebuilt ${channel.flavor === 'sea' ? 'Node' : 'Deno'} binary is published for ${deps.platform ?? process.platform}-${deps.arch ?? process.arch}.\n`,
    );
    return 2;
  }

  out.log(`Downloading qunitx ${target} (${assetName})...\n`);
  const replaced = await (deps.apply ?? Install.apply)({
    release,
    assetName,
    binaryPath: channel.binaryPath,
    platform: deps.platform,
  }).catch((error: unknown) => {
    out.error(`${Failure.format(error)}\n`);
    return null;
  });
  if (!replaced) return 2;

  out.log(`qunitx ${current} → ${target}\n`);
  for (const file of replaced) out.log(`  replaced ${file}\n`);

  return 0;
}

/**
 * Parses `qunitx upgrade`'s arguments. A bare `0.34.2` (or `v0.34.2`) pins the version, the same
 * as `--version=0.34.2`.
 *
 * ```ts
 * import * as Upgrade from './index.ts';
 *
 * const options = Upgrade.parseArgs(['0.34.2', '--check']);
 * Upgrade.InvalidArgument.is(options) ? null : options.version; // '0.34.2'
 * ```
 */
export function parseArgs(
  argv: string[],
): Result<UpgradeOptions, Failure.Of<typeof InvalidArgument>> {
  const options: UpgradeOptions = {
    check: false,
    force: false,
    help: false,
    writeManifest: false,
  };

  for (const argument of argv) {
    if (argument === '--check') options.check = true;
    else if (argument === '--force') options.force = true;
    else if (argument === '--help' || argument === '-h' || argument === 'help') options.help = true;
    else if (argument === '--write-manifest') options.writeManifest = true;
    else if (argument.startsWith('--version='))
      options.version = argument.slice(10).replace(/^v/, '');
    else if (VERSION_ARGUMENT.test(argument)) options.version = argument.replace(/^v/, '');
    else return InvalidArgument({ argument });
  }

  return options;
}

// Why this channel will not replace itself, in one sentence each. The command to run instead is
// printed by the caller, from Channel.updateCommand.
function refusal(channel: Channel.InstallChannel, current: string): string {
  if (channel.kind === 'npm-local') {
    return `qunitx ${current} is a devDependency of ${channel.projectRoot}; bumping it is a change to that project, so this command will not make it for you.`;
  } else if (channel.kind === 'npm-global') {
    return `qunitx ${current} was installed by npm under ${channel.prefix}, and npm owns those files.`;
  } else if (channel.kind === 'deno-project') {
    return `qunitx ${current} is a dependency of ${channel.projectRoot}, declared in ${basename(channel.manifest)}; bumping it is a change to that project, so this command will not make it for you.`;
  } else if (channel.kind === 'jsr-launcher') {
    return `qunitx ${current} is the JSR launcher's cache for that exact version; replacing it would make a launcher pinned to ${channel.version} run something else.`;
  } else if (channel.kind === 'deno-cache') {
    return `qunitx ${current} came straight from deno's module cache, so there is no installation to upgrade — ask for the version you want, in the command or in deno.json.`;
  }

  return `qunitx ${current} is running from a source checkout (${channel.kind === 'source' ? channel.entry : ''}).`;
}

function describe(channel: Channel.InstallChannel): string {
  if (channel.kind === 'standalone') return 'a standalone binary';
  else if (channel.kind === 'jsr-launcher') return "the JSR launcher's cached binary";
  else if (channel.kind === 'deno-cache') return "a one-off run out of deno's module cache";
  else if (channel.kind === 'npm-global') return 'a global npm install';
  else if (channel.kind === 'source') return 'a source checkout';

  return 'a project dependency';
}
