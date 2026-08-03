#!/usr/bin/env node
// Must be first: ESM evaluates dependencies post-order, so the cache is
// turned on before chrome-prelaunch.ts and the rest of the dep graph compile.
import './lib/utils/enable-compile-cache.ts';
// Must run before the esbuild import inside run.ts: side-effect module that points
// `ESBUILD_BINARY_PATH` at a sidecar esbuild adjacent to the binary. No-op when the
// env is already set or no sidecar is present (npm / source / Node SEA paths).
import './lib/utils/find-sidecar-esbuild.ts';
import process from 'node:process';
import { shutdownPrelaunch, startPrelaunch } from './lib/chrome/prelaunch.ts';
import { Failure } from './lib/result/index.ts';
import pkg from './package.json' with { type: 'json' };

process.title = 'qunitx';
// First statement, and deliberately so: this spawns Chrome for run commands, and the whole
// point is that its ~150ms start-up overlaps the dynamic import of playwright-core below
// rather than following it. Everything between here and that import is synchronous.
startPrelaunch();

// The timer is a LAST RESORT, not a routine path: whenever it fires before the drain callback,
// process.exit() drops whatever is still queued. run.ts learned this the hard way and uses the
// same 30s — on Windows under 16-way CI load the callback can take far longer than seems
// reasonable, because the parent reader is busy, the OS pipe buffer fills, and Node's userland
// write queue stalls until the reader catches up. 250ms was tight enough to be the normal path
// there, which is exactly what it must never be.
const FLUSH_GRACE_MS = 30_000;
// Conventional exit code for a process terminated by SIGTERM (128 + signal number 15).
const EXIT_CODE_SIGTERM = 128 + 15;

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
    const { path, created } = await (await import('./lib/commands/generate.ts')).run();
    const { green } = await import('./lib/utils/color.ts');
    return console.log(created ? green(`${path} written`) : `${path} already exists!`);
  } else if (cmd === 'init') {
    const { written, skipped } = await (await import('./lib/commands/init.ts')).run();
    // The scaffolding commands report what they did and let this decide how to say it — the same
    // split as everywhere else, so `Qunitx.init()` returns the facts instead of printing them.
    skipped.forEach((file) => console.log(`${file} already exists`));
    return written.forEach((file) => console.log(`${file} written`));
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
  const [Config, { run, watch }] = await Promise.all([
    import('./lib/setup/config.ts'),
    import('./lib/commands/run.ts'),
  ]);
  // The one place a bad flag or a broken plugin becomes a message and an exit code. Config
  // assembly used to do this itself, at eight separate `console.error` + `process.exit(1)`
  // pairs buried in a pure argv transform.
  const config = await Config.setup().result();
  if (Failure.is(config)) {
    console.error(Failure.format(config));
    // BEFORE the cleanup await, not after. `shutdownPrelaunch()` waits on a Chrome that may
    // still be starting — on the Windows runner CDP came ready 1.8s after this point — and if
    // the loop drains around that wait, Node exits on its own. An unset `exitCode` at that
    // moment means a run that could not read its inputs reports success.
    process.exitCode = 1;
    await shutdownPrelaunch();
    return exitAfterFlush(1);
  }

  // --search/--print lists what the filter matches and exits: no browser, no bundle, no tests.
  // Chrome was pre-launched at module load, so shut it back down rather than leaking it.
  if (config.search) {
    const Search = await import('./lib/commands/search.ts');
    const exitCode = await Search.run(config);
    await shutdownPrelaunch();
    return exitAfterFlush(exitCode);
  }

  // Watch mode hands back a live session and leaves the process running. Everything that makes
  // it a *terminal* session rather than a library call — stdin shortcuts, the SIGTERM handler,
  // the banner — is wired up here, because `lib/` has no business owning any of the three.
  if (config.watch) {
    const session = await watch(config);
    const [KeyboardEvents, { blue }] = await Promise.all([
      import('./lib/setup/keyboard-events.ts'),
      import('./lib/utils/color.ts'),
    ]);
    KeyboardEvents.setup(session.config, session.connections);
    // Close the HTTP server explicitly on SIGTERM so the port is reclaimed by application code
    // rather than as a side effect of OS process cleanup — on macOS, waitpid() can return a few
    // ms before the socket is reclaimed, which makes the port look busy to whatever starts next.
    // On Windows child.kill('SIGTERM') calls TerminateProcess() so this never runs, and
    // TerminateProcess is synchronous, so the race doesn't exist there either.
    process.once('SIGTERM', () => {
      void session.close().finally(() => process.exit(EXIT_CODE_SIGTERM));
    });
    console.log('#', blue(`Watching files... You can browse the tests on ${session.url} ...`));
    return console.log(
      '#',
      blue(
        `Shortcuts: Press "qq" to abort running tests, "qa" to run all the tests, "qf" to run last failing test, "ql" to repeat last test`,
      ),
    );
  }

  const outcome = await run(config);
  // The trailing newline the batch run has always ended on. Daemon-routed runs skip it — the
  // daemon's own local run produced it inside the socket stream already.
  process.stdout.write('\n');

  return exitAfterFlush(outcome.exitCode);
})().catch(async (error) => {
  // The program's ONE crash boundary, and the two-tier rule at the very edge: a declared failure
  // is a message (`init`/`generate` reach here when there is no package.json to work in), a bug
  // keeps its stack — both exit 1. Library functions used to make this call themselves with a
  // bare `process.exit(1)`, which no caller could test or override.
  //
  // Set first, for the same reason as above: nothing awaited below may decide the exit code by
  // draining the loop out from under us.
  process.exitCode = 1;
  await shutdownPrelaunch();
  console.error(Failure.is(error) ? Failure.format(error) : error);
  exitAfterFlush(1);
});

// Exits with `code` after giving stdio a chance to drain.
//
// The write callback is only the fast path. An exit that DEPENDS on it is not an exit: under
// Deno on Windows the callback does not fire, and a process that then falls off the end of the
// program reports a broken run as a passing one. So the timer is the guarantee and `exitCode`
// covers the case where the loop drains on its own first — three ways to reach the same code,
// because the one thing that must not happen is exiting 0.
function exitAfterFlush(code: number): void {
  process.exitCode = code;
  const exit = (route: string) => () => {
    // Under --debug only: which of the three routes actually ended the process, and with what.
    // `Inputs | unresolvable inputs` fails on Windows and macOS with the failure correctly
    // reported and the code coming out 0, which none of the three can produce — so the next
    // occurrence should say whether any of them ran at all.
    if (process.env.QUNITX_DEBUG) {
      process.stderr.write(`# [qunitx] exiting ${code} via ${route}\n`);
    }
    process.exit(code);
  };
  process.stdout.write('', exit('stdout-drain'));
  setTimeout(exit('flush-timer'), FLUSH_GRACE_MS);
}
