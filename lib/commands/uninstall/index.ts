import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { blue, magenta, red } from '../../utils/color.ts';
import { processConsole, type Console } from '../../console.ts';
import { Failure, type Result } from '../../result/index.ts';
import * as Channel from '../upgrade/channel.ts';
import * as Client from '../daemon/client.ts';
import * as Manifest from './manifest.ts';
import * as Process from '../upgrade/process.ts';
import * as UpgradeManifest from '../upgrade/manifest.ts';
import { planFor, type UninstallPlan } from './plan.ts';
import pkg from '../../../package.json' with { type: 'json' };

// `qunitx uninstall` — the other end of `qunitx upgrade`, and the same six channels.
//
// Two of them qunitx installed and removes itself. Two belong to a package manager, which is asked
// to do it, exactly as `upgrade` asks it to install. Two are not installs at all — a project
// dependency is someone's repository, and a source checkout is a working tree — and for those the
// answer is the command that would do it, not the deletion.
//
// Everything that touches the disk arrives through `UninstallDeps`, so every branch below is
// reachable in a test without uninstalling the qunitx running it.

const highlight = (text: string): string => magenta().bold(text);
const color = (text: string): string => blue(text);

const USAGE = `${highlight(`[qunitx v${pkg.version}] Usage:`)} qunitx ${color('uninstall [--dry-run] [--yes]')}

${highlight('Examples:')}
${color('$ qunitx uninstall')}                 # remove this install, after saying what it will remove
${color('$ qunitx uninstall --dry-run')}       # print exactly that list and stop
${color('$ qunitx uninstall --yes')}           # skip the question (what a script wants)

${highlight('Flags:')}
${color('--dry-run')}             : print what would be removed and exit without touching anything
${color('--yes')}, ${color('-y')}             : do not ask for confirmation
${color('--keep-cache')}          : leave the downloaded-binary cache where it is
${color('--write-manifest')}      : project dependency only — drop the entry from package.json or deno.json (you run the install)

${highlight('What it does per install:')}
- standalone binary (${color('install.sh')}) : removes the binary, its esbuild sidecar and the musl bundle
- ${color('deno install')} from JSR          : runs ${color('deno uninstall -g qunitx-cli')}, then clears the binary cache
- ${color('npm install -g')}                 : runs ${color('npm uninstall -g qunitx-cli')}
- ${color('npm')} / ${color('deno')} project dependency  : refuses — removing it changes that project (see ${color('--write-manifest')})
- ${color('deno run npm:qunitx-cli')}        : nothing was installed, so nothing is removed
- source checkout                : refuses — that is a working tree, and ${color('git')} owns it

${highlight('Environment:')}
${color('QUNITX_NO_SELF_UPGRADE=1')} : never run another package manager; print the command instead

${highlight('Exit codes:')} ${color('0')} removed, or nothing to remove, ${color('1')} this install is removed another way, ${color('2')} something went wrong.
`;

/**
 * An argument this command will not accept.
 *
 * ```ts
 * import * as Uninstall from './index.ts';
 *
 * Uninstall.InvalidArgument({ argument: '--yolo' }).message; // 'Unknown qunitx uninstall argument: --yolo'
 * ```
 */
export const InvalidArgument: Failure.FailureFactory<
  'InvalidUninstallArgument',
  { argument: string }
> = Failure.define(
  'InvalidUninstallArgument',
  (data: { argument: string }) => `Unknown qunitx uninstall argument: ${data.argument}`,
);

/**
 * What `qunitx uninstall`'s argv asked for.
 *
 * ```ts
 * import type { UninstallOptions } from './index.ts';
 *
 * const options: UninstallOptions = { dryRun: true, yes: false, help: false, keepCache: false, writeManifest: false };
 * options.dryRun; // true — say what would go, remove nothing
 * ```
 */
export interface UninstallOptions {
  /** Print the plan and stop. */
  dryRun: boolean;
  /** Remove without asking. */
  yes: boolean;
  /** Print the usage instead of doing anything. */
  help: boolean;
  /** Leave the downloaded-binary cache alone. */
  keepCache: boolean;
  /** Project dependency only: take the entry out of the manifest. */
  writeManifest: boolean;
}

/**
 * The seams this command reaches the world through. Every one defaults to the real thing.
 *
 * ```ts
 * import type { UninstallDeps } from './index.ts';
 *
 * const deps: UninstallDeps = { channel: { kind: 'source', entry: '/repo/cli.ts' } };
 * deps.channel?.kind; // 'source' — refuses without looking at the filesystem
 * ```
 */
export interface UninstallDeps {
  /** Where the command's output goes. Defaults to the process streams. */
  console?: Console;
  /** The install channel. Defaults to {@link Channel.detect}. */
  channel?: Channel.InstallChannel;
  /** Environment the cache root is read from. Defaults to this process's. */
  env?: Record<string, string | undefined>;
  /** Path semantics and cache layout to apply. Defaults to the host's. */
  platform?: NodeJS.Platform;
  /** Runs another tool's uninstaller. Defaults to {@link Process.spawn}. */
  spawn?: (argv: string[]) => Promise<Process.SpawnResult>;
  /** Removes one path, recursively. Defaults to `fs.rm`. */
  remove?: (target: string) => Promise<void>;
  /** Whether a path is there at all. Defaults to `fs.stat`, following no symlink. */
  exists?: (target: string) => Promise<boolean>;
  /** Asks the question. Defaults to a prompt on the terminal; a test answers it directly. */
  confirm?: (question: string) => Promise<boolean>;
  /** Stops a running daemon first. Defaults to {@link Client.shutdown}. */
  stopDaemon?: () => Promise<boolean>;
  /**
   * Whether qunitx may run another package manager on the user's behalf. Defaults to true unless
   * `QUNITX_NO_SELF_UPGRADE` is set — the same switch `upgrade` reads, because it is the same
   * question and nobody wants two of them.
   */
  allowSelfUninstall?: boolean;
}

/**
 * Removes this install, or says who does.
 *
 * ```ts
 * import type { run } from './index.ts';
 *
 * // Defined, not invoked: it deletes files.
 * async function example(uninstall: typeof run) {
 *   return await uninstall(['--dry-run']); // 0 — printed the plan, removed nothing
 * }
 * ```
 *
 * @returns the process exit code.
 */
export async function run(
  argv: string[] = process.argv.slice(3),
  deps: UninstallDeps = {},
): Promise<number> {
  const out = deps.console ?? processConsole;
  const options = parseArgs(argv);
  if (Failure.is(options)) {
    out.error(`${options.message}\n\n${USAGE}`);

    return 2;
  } else if (options.help) {
    out.log(USAGE);

    return 0;
  }

  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const channel = deps.channel ?? Channel.detect();
  const registry =
    channel.kind === 'deno-project' ? await UpgradeManifest.registry(channel.manifest) : 'npm';
  const plan = planFor(channel, env, platform, registry);

  if (plan.kind === 'nothing') {
    out.log(`${plan.why}\n`);

    return 0;
  } else if (plan.kind === 'refuse') {
    return await refuse(out, plan, options, deps);
  }

  const removals = await present(plan, options, deps);
  if (options.dryRun) {
    out.log(
      `${describe(channel)} — ${plan.argv ? `would run \`${plan.argv.join(' ')}\`` : 'would remove'}:\n`,
    );
    for (const target of removals) out.log(`  ${target}\n`);
    if (removals.length === 0 && !plan.argv) out.log('  nothing is there to remove\n');

    return 0;
  }

  if (!options.yes) {
    const asked = await confirmation(deps, plan, removals, describe(channel));
    if (!asked) {
      out.log('Left alone.\n');

      return 0;
    }
  }

  // Before the binary goes: a daemon is a detached process holding a browser and a socket, and it
  // would outlive the qunitx that could stop it.
  await (deps.stopDaemon ?? (() => Client.shutdown()))().catch(() => false);

  if (plan.argv) {
    const ran = await runOwner(out, plan.argv, deps);
    if (ran !== 0) return ran;
  }

  const removeOne =
    deps.remove ?? ((target: string) => fs.rm(target, { recursive: true, force: true }));
  for (const target of removals) {
    const failed = await removeOne(target).then(
      () => null,
      (error: unknown) => error,
    );
    if (failed) {
      out.error(red(`could not remove ${target}: ${(failed as Error)?.message ?? failed}\n`));

      return 2;
    }
    out.log(`  removed ${target}\n`);
  }

  out.log(`qunitx ${pkg.version} is uninstalled.\n`);

  return 0;
}

/**
 * Parses `qunitx uninstall`'s arguments.
 *
 * ```ts
 * import * as Uninstall from './index.ts';
 *
 * const options = Uninstall.parseArgs(['--dry-run']);
 * Uninstall.InvalidArgument.is(options) ? null : options.dryRun; // true
 * ```
 */
export function parseArgs(
  argv: string[],
): Result<UninstallOptions, Failure.Of<typeof InvalidArgument>> {
  const options: UninstallOptions = {
    dryRun: false,
    yes: false,
    help: false,
    keepCache: false,
    writeManifest: false,
  };

  for (const argument of argv) {
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--yes' || argument === '-y') options.yes = true;
    else if (argument === '--help' || argument === '-h' || argument === 'help') options.help = true;
    else if (argument === '--keep-cache') options.keepCache = true;
    else if (argument === '--write-manifest') options.writeManifest = true;
    else return InvalidArgument({ argument });
  }

  return options;
}

/** The removals that are actually there, minus the cache when it was asked to stay. */
async function present(
  plan: UninstallPlan,
  options: UninstallOptions,
  deps: UninstallDeps,
): Promise<string[]> {
  const isThere =
    deps.exists ??
    ((target: string) =>
      fs.lstat(target).then(
        () => true,
        () => false,
      ));
  const wanted = options.keepCache
    ? plan.removals.filter((target) => path.basename(target) !== 'qunitx')
    : plan.removals;
  const answers = await Promise.all(wanted.map(isThere));

  return wanted.filter((_target, at) => answers[at] === true);
}

/** A project dependency or a checkout: the command that would do it, and why this will not. */
async function refuse(
  out: Console,
  plan: UninstallPlan,
  options: UninstallOptions,
  deps: UninstallDeps,
): Promise<number> {
  if (options.writeManifest && plan.manifest !== undefined) {
    const block = await Manifest.remove(plan.manifest).then(
      (name) => name,
      (error: unknown) => error,
    );
    if (typeof block !== 'string') {
      out.error(`${Failure.format(block)}\n`);

      return 2;
    }
    out.log(`Removed qunitx-cli from ${block} in ${plan.manifest}.\n`);
    if (plan.argv) out.log(`  ${plan.argv.join(' ')} takes it out of the install too.\n`);

    return 0;
  }

  out.log(`${plan.why}\n`);
  if (plan.argv) out.log(`  ${plan.argv.join(' ')}\n`);
  if (plan.manifest !== undefined) {
    out.log(
      `  ${color('qunitx uninstall --write-manifest')} drops the entry from ${path.basename(plan.manifest)} instead.\n`,
    );
  }
  void deps;

  return 1;
}

/** Runs the package manager that owns this install, and reports how that went. */
async function runOwner(out: Console, argv: string[], deps: UninstallDeps): Promise<number> {
  const allowed =
    deps.allowSelfUninstall ?? (deps.env ?? process.env).QUNITX_NO_SELF_UPGRADE === undefined;
  if (!allowed) {
    out.log(`This install is ${argv[0]}'s. Run:\n  ${argv.join(' ')}\n`);

    return 1;
  }

  out.log(`Running \`${argv.join(' ')}\`:\n`);
  const { exitCode, signalCode, isMissingInstallerBinary } = await (deps.spawn ?? Process.spawn)(
    argv,
  );
  if (isMissingInstallerBinary) {
    out.error(`${argv[0]} is not installed, so qunitx cannot run that for you.\n`);

    return 2;
  } else if (exitCode !== 0) {
    const ending = signalCode ? `was killed by ${signalCode}` : `exited ${exitCode}`;
    out.error(`${argv[0]} ${ending} — nothing else was removed.\n`);

    return exitCode ?? 2;
  }

  return 0;
}

/** The question, asked on the terminal. A run with nothing attached to it answers no. */
async function confirmation(
  deps: UninstallDeps,
  plan: UninstallPlan,
  removals: string[],
  what: string,
): Promise<boolean> {
  const listed = [
    `About to uninstall qunitx (${what}).`,
    ...(plan.argv ? [`  run: ${plan.argv.join(' ')}`] : []),
    ...removals.map((target) => `  remove: ${target}`),
  ].join('\n');

  if (deps.confirm) return await deps.confirm(listed);
  if (!process.stdin.isTTY) {
    processConsole.error(`${listed}\n\nNot a terminal — pass --yes to go ahead.\n`);

    return false;
  }

  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`${listed}\n\nGo ahead? [y/N] `);

    return /^y(es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

/** How an install is named in a sentence — the same words `upgrade` uses for it. */
function describe(channel: Channel.InstallChannel): string {
  if (channel.kind === 'standalone') {
    return `the standalone ${channel.flavor === 'sea' ? 'Node' : 'Deno'} binary`;
  } else if (channel.kind === 'jsr-launcher') return "deno's JSR install";
  else if (channel.kind === 'npm-global') return 'the global npm install';

  return channel.kind;
}
