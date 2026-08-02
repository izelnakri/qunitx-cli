#!/usr/bin/env node
// Must be first: ESM evaluates dependencies post-order, so the cache is
// turned on before chrome-prelaunch.ts and the rest of the dep graph compile.
import './lib/utils/enable-compile-cache.ts';
// Must run before the esbuild import inside run.ts: side-effect module that points
// `ESBUILD_BINARY_PATH` at a sidecar esbuild adjacent to the binary. No-op when the
// env is already set or no sidecar is present (npm / source / Node SEA paths).
import './lib/utils/find-sidecar-esbuild.ts';
import process from 'node:process';
import { shutdownPrelaunch } from './lib/chrome/prelaunch.ts';
import { Failure } from './lib/result/index.ts';
import pkg from './package.json' with { type: 'json' };

process.title = 'qunitx';

// Exits with `code` after giving stdio a chance to drain.
//
// The write callback is only the fast path. An exit that DEPENDS on it is not an exit: under
// Deno on Windows the callback does not fire, and a process that then falls off the end of the
// program reports a broken run as a passing one. So the timer is the guarantee and `exitCode`
// covers the case where the loop drains on its own first — three ways to reach the same code,
// because the one thing that must not happen is exiting 0.
function exitAfterFlush(code: number): void {
  process.exitCode = code;
  const exit = () => process.exit(code);
  process.stdout.write('', exit);
  setTimeout(exit, FLUSH_GRACE_MS);
}

// Long enough for a piped stdout to drain on a loaded CI box, short enough that nobody waits on
// it — it only ever runs when the callback above has already failed to fire.
const FLUSH_GRACE_MS = 250;

// Command-module imports are dynamic so the daemon-routed-run path doesn't
// load `help.ts`, `init.ts`, `generate.ts`, or `setup/config.ts` (and its
// transitive `fs-tree` / `find-project-root` / `parse-cli-flags` chain) just
// to discard them. Saves ~50-80ms of unused module evaluation on every
// daemon-routed cli invocation. The cost on the rare commands (help, init,
// generate) is one extra ~5ms dynamic-import resolution — below human
// perception and not on any hot path. chrome-prelaunch.ts stays static
// because its module-eval kicks off Chrome pre-launch and must run before
// playwright-core starts loading on local-run paths.

(async () => {
  const cmd = process.argv[2];
  if (!cmd) {
    return await (await import('./lib/commands/help.ts')).run();
  } else if (['--version', '-v', 'version'].includes(cmd)) {
    return process.stdout.write(pkg.version + '\n');
  } else if (['help', 'h', 'p', 'print'].includes(cmd)) {
    return await (await import('./lib/commands/help.ts')).run();
  } else if (['new', 'n', 'g', 'generate'].includes(cmd)) {
    return await (await import('./lib/commands/generate.ts')).run();
  } else if (cmd === 'init') {
    return await (await import('./lib/commands/init.ts')).run();
  } else if (cmd === 'daemon') {
    const Daemon = await import('./lib/commands/daemon/index.ts');
    process.exit(await Daemon.run());
  }

  // Daemon-routed run: when a live daemon exists for this cwd (or QUNITX_DAEMON=1
  // opted into auto-spawn), dispatch the work over the Unix socket and stream TAP
  // back. Saves ~800ms by reusing the daemon's persistent Chrome and warm esbuild
  // context. Falls through on connect failure.
  const Client = await import('./lib/commands/daemon/client.ts');
  let useDaemon = Client.shouldUse();
  if (!useDaemon && Client.shouldAutoSpawn()) {
    const { ensureRunning } = await import('./lib/commands/daemon/index.ts');
    useDaemon = await ensureRunning();
  }
  if (useDaemon) {
    // `mapErr(Failure.from)` is the adapter edge: it sees every rejection, so a bug inside the
    // client becomes a Failure instead of being erased, exactly as the `tryCatch` this replaces
    // did — but in the same chain, so `.result()` yields one union to discriminate rather than a
    // box wrapping one. The fall-through stays unconditional; only "the daemon died mid-run"
    // says so, because it used to be indistinguishable from exit 1.
    const routed = await Client.runVia(process.argv.slice(2)).mapErr(Failure.from).result();
    if (!Failure.is(routed)) return exitAfterFlush(routed);
    if (routed.code !== 'DaemonUnreachable') {
      process.stderr.write(`# [qunitx] ${Failure.format(routed)} — running locally\n`);
    }
  }

  // Local-run path: lazy-import Config.setup + run.ts (and their transitive
  // chains: esbuild, playwright-core, fs-tree, etc.). Loading in parallel lets
  // playwright-core's heavy module evaluation overlap with config assembly.
  const [Config, { run }] = await Promise.all([
    import('./lib/setup/config.ts'),
    import('./lib/commands/run.ts'),
  ]);
  // The one place a bad flag or a broken plugin becomes a message and an exit code. Config
  // assembly used to do this itself, at eight separate `console.error` + `process.exit(1)`
  // pairs buried in a pure argv transform.
  const configured = await Config.setup();
  if (Failure.is(configured)) {
    console.error(Failure.format(configured));
    await shutdownPrelaunch();
    return exitAfterFlush(1);
  }
  const config = configured;

  // --search/--print lists what the filter matches and exits: no browser, no bundle, no tests.
  // Chrome was pre-launched at module load, so shut it back down rather than leaking it.
  if (config.search) {
    const Search = await import('./lib/commands/search.ts');
    const exitCode = await Search.run(config);
    await shutdownPrelaunch();
    return exitAfterFlush(exitCode);
  }

  return await run(config);
})().catch(async (error) => {
  // The program's ONE crash boundary, and the two-tier rule at the very edge: a declared failure
  // is a message (`init`/`generate` reach here when there is no package.json to work in), a bug
  // keeps its stack — both exit 1. Library functions used to make this call themselves with a
  // bare `process.exit(1)`, which no caller could test or override.
  await shutdownPrelaunch();
  console.error(Failure.is(error) ? Failure.format(error) : error);
  exitAfterFlush(1);
});
