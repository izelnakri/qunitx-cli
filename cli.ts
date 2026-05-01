#!/usr/bin/env node
// Must be first: ESM evaluates dependencies post-order, so the cache is
// turned on before chrome-prelaunch.ts and the rest of the dep graph compile.
import './lib/utils/enable-compile-cache.ts';
import process from 'node:process';
import { shutdownPrelaunch } from './lib/utils/chrome-prelaunch.ts';
import pkg from './package.json' with { type: 'json' };

process.title = 'qunitx';

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
    return await (await import('./lib/commands/help.ts')).displayHelpOutput();
  } else if (['--version', '-v', 'version'].includes(cmd)) {
    return process.stdout.write(pkg.version + '\n');
  } else if (['help', 'h', 'p', 'print'].includes(cmd)) {
    return await (await import('./lib/commands/help.ts')).displayHelpOutput();
  } else if (['new', 'n', 'g', 'generate'].includes(cmd)) {
    return await (await import('./lib/commands/generate.ts')).generateTestFiles();
  } else if (cmd === 'init') {
    return await (await import('./lib/commands/init.ts')).initializeProject();
  } else if (cmd === 'daemon') {
    const { runDaemonCommand } = await import('./lib/commands/daemon/index.ts');
    process.exit(await runDaemonCommand());
  }

  // Daemon-routed run: when a live daemon exists for this cwd (or QUNITX_DAEMON=1
  // opted into auto-spawn), dispatch the work over the Unix socket and stream TAP
  // back. Saves ~800ms by reusing the daemon's persistent Chrome and warm esbuild
  // context. Falls through on connect failure.
  const { shouldUseDaemon, shouldAutoSpawnDaemon, runViaDaemon } =
    await import('./lib/commands/daemon/client.ts');
  let useDaemon = shouldUseDaemon();
  if (!useDaemon && shouldAutoSpawnDaemon()) {
    const { ensureDaemonRunning } = await import('./lib/commands/daemon/index.ts');
    useDaemon = await ensureDaemonRunning();
  }
  if (useDaemon) {
    try {
      const exitCode = await runViaDaemon(process.argv.slice(2));
      process.stdout.write('', () => process.exit(exitCode));
      return;
    } catch {
      // Daemon disappeared mid-handshake — fall through to a local run.
    }
  }

  // Local-run path: lazy-import setupConfig + run.ts (and their transitive
  // chains: esbuild, playwright-core, fs-tree, etc.). Loading in parallel lets
  // playwright-core's heavy module evaluation overlap with config assembly.
  const [{ setupConfig }, { run }] = await Promise.all([
    import('./lib/setup/config.ts'),
    import('./lib/commands/run.ts'),
  ]);
  const config = await setupConfig();

  try {
    return await run(config);
  } catch (error) {
    console.error(error);
    // Flush stdout before exit so any queued console.log writes (e.g. from WS testEnd
    // handlers that fired before the exception) are not lost when process.exit() runs.
    process.exitCode = 1;
    await shutdownPrelaunch();
    process.stdout.write('\n', () => process.exit(1));
  }
})();
