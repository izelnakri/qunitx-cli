// `globalThis.exitCode` is the browser-side equivalent of `process.exitCode`.
console.log('setting an exit code');

(globalThis as { exitCode?: number }).exitCode = 3;
