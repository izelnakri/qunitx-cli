// Stands in for any process that cleans up from a `process.on('exit')` hook — which is exactly how
// playwright kills the browser it launched, and how the pre-launched Chrome is reaped.
//
// Usage: node test/fixtures/signal-exit-hook.ts <marker-path> [--bare]
import fs from 'node:fs';
import process from 'node:process';
import { exitOnSignal } from '../../lib/utils/exit-on-signal.ts';

const [marker, bare] = process.argv.slice(2);

process.on('exit', () => fs.writeFileSync(marker, 'exit hook ran'));
// `--bare` is the control: no wiring, which is what every non-watch run used to be.
if (bare !== '--bare') exitOnSignal();

console.log('ready');
setInterval(() => {}, 1_000);
