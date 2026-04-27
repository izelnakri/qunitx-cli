#!/usr/bin/env node
import process from 'node:process';
import { shutdownPrelaunch } from './lib/utils/chrome-prelaunch.ts';
import { displayHelpOutput } from './lib/commands/help.ts';
import { initializeProject } from './lib/commands/init.ts';
import { generateTestFiles } from './lib/commands/generate.ts';
import { setupConfig } from './lib/setup/config.ts';
import pkg from './package.json' with { type: 'json' };

process.title = 'qunitx';

(async () => {
  const cmd = process.argv[2];
  if (!cmd) {
    return await displayHelpOutput();
  } else if (['--version', '-v', 'version'].includes(cmd)) {
    return process.stdout.write(pkg.version + '\n');
  } else if (['help', 'h', 'p', 'print'].includes(cmd)) {
    return await displayHelpOutput();
  } else if (['new', 'n', 'g', 'generate'].includes(cmd)) {
    return await generateTestFiles();
  } else if (cmd === 'init') {
    return await initializeProject();
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

  // Lazy import: run.js (and its static imports like esbuild and playwright-core) are
  // only loaded when actually running tests. Importing in parallel with setupConfig()
  // lets playwright-core start loading while config is being assembled.
  const [config, { run }] = await Promise.all([setupConfig(), import('./lib/commands/run.ts')]);

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
