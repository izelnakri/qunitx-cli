#!/usr/bin/env node
import process from 'node:process';
import './lib/utils/early-chrome.js';
import displayHelpOutput from './lib/commands/help.js';
import initializeProject from './lib/commands/init.js';
import generateTestFiles from './lib/commands/generate.js';
import setupConfig from './lib/setup/config.js';

process.title = 'qunitx';

(async () => {
  if (!process.argv[2]) {
    return await displayHelpOutput();
  } else if (['help', 'h', 'p', 'print'].includes(process.argv[2])) {
    return await displayHelpOutput();
  } else if (['new', 'n', 'g', 'generate'].includes(process.argv[2])) {
    return await generateTestFiles();
  } else if (['init'].includes(process.argv[2])) {
    return await initializeProject();
  }

  // Lazy import: run.js (and its static imports like esbuild and playwright-core) are
  // only loaded when actually running tests. Importing in parallel with setupConfig()
  // lets playwright-core start loading while config is being assembled.
  const [config, { default: run }] = await Promise.all([
    setupConfig(),
    import('./lib/commands/run.js'),
  ]);

  try {
    return await run(config);
  } catch (error) {
    console.error(error);
    // Flush stdout before exit so any queued console.log writes (e.g. from WS testEnd
    // handlers that fired before the exception) are not lost when process.exit() runs.
    process.exitCode = 1;
    process.stdout.write('\n', () => process.exit(1));
  }
})();
