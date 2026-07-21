// Barrel assembling the `Chrome` namespace: import * as Chrome from '.../chrome/index.ts'.
// prelaunch.ts is deliberately excluded — it spawns Chrome at module eval, and the barrel
// must stay side-effect-free so importing Chrome never launches a browser.
export { find } from './find.ts';
export { spawn } from './spawn.ts';
export { cleanupDir } from './cleanup-dir.ts';
export { CHROMIUM_ARGS } from './chromium-args.ts';
