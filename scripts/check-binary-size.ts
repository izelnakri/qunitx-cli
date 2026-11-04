import fs from 'node:fs/promises';
import process from 'node:process';

// The most a standalone qunitx binary may weigh — the deno-compiled one, the Node SEA and the musl
// build alike — checked by CI wherever one is built.
//
// A binary carrying dead weight still runs, so nothing else notices: 0.42.0's deno binary shipped
// at 213 MB, 84 MB of it devDependencies embedded by `deno compile`. Without them every flavor is
// 120–135 MB. Raise this on purpose, when a runtime grows; never to make a build pass.

/** The budget, in MiB. */
export const BUDGET_MB = 180;

// `node scripts/check-binary-size.ts <binary>` — `<binary>.exe` is tried too, so one call serves
// every platform.
if (process.argv[1]?.endsWith('check-binary-size.ts')) {
  const given = process.argv[2];
  if (given === undefined) {
    process.stderr.write('Usage: node scripts/check-binary-size.ts <binary>\n');
    process.exit(2);
  }
  const stat = await fs
    .stat(given)
    .catch(() => fs.stat(`${given}.exe`))
    .catch(() => null);
  if (stat === null) {
    process.stderr.write(`No binary at ${given} (or ${given}.exe) to check.\n`);
    process.exit(1);
  }
  const mb = Math.round(stat.size / 1048576);
  if (mb > BUDGET_MB) {
    process.stderr.write(
      `OVER BUDGET: ${given} is ${mb} MB, over the ${BUDGET_MB} MB budget.\n` +
        'Is a devDependency, or a whole node_modules, embedded in it?\n',
    );
    process.exit(1);
  }
  process.stdout.write(`${given}: ${mb} MB (budget: ${BUDGET_MB} MB)\n`);
}
