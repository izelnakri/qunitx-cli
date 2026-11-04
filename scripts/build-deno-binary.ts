import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

// `deno compile` for the binary that install.sh and `qunitx upgrade` hand out, from a staging copy
// whose package.json has no devDependencies.
//
// With `nodeModulesDir: "auto"` Deno installs everything package.json names and the compile embeds
// all of it, so the 0.42.0 binary was 213 MB of which 84 MB was TypeScript's native compiler,
// prettier, React, Vue, mocha and the rest of the dev tooling — none of it reachable from cli.ts.
// Measured on linux-x64: 213 MB → 132 MB, the gzipped download 68 MB → 48 MB.
//
// Run by `deno task build:binary`; extra arguments pass through, e.g. `--target <triple>` and
// `--output dist/qunitx-linux-x64`. The output defaults to dist/qunitx.

const ROOT = path.resolve(import.meta.dirname!, '..');
const INCLUDED = ['cli.ts', 'lib', 'templates', 'deno.json', 'deno.lock'];

// The compile runs in the staging directory, so the output is made absolute against this one.
const args = process.argv.slice(2);
const outputAt = args.indexOf('--output');
if (outputAt === -1) args.push('--output', path.resolve('dist/qunitx'));
else args[outputAt + 1] = path.resolve(args[outputAt + 1]);

const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'qunitx-deno-binary-'));
try {
  await Promise.all(
    INCLUDED.map((name) =>
      fs.cp(path.join(ROOT, name), path.join(staging, name), { recursive: true }),
    ),
  );
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  delete pkg.devDependencies;
  await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify(pkg, null, 2));

  // This script runs under Deno, so its own executable is the `deno` to compile with.
  const { status } = spawnSync(
    process.execPath,
    [
      'compile',
      '--allow-all',
      '--no-check',
      '--include',
      'templates',
      '--include',
      'lib',
      '--include',
      'package.json',
      ...args,
      'cli.ts',
    ],
    { cwd: staging, stdio: 'inherit' },
  );
  process.exitCode = status ?? 1;
} finally {
  await fs.rm(staging, { recursive: true, force: true });
}
