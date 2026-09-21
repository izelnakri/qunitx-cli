import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as esbuild from 'esbuild';
import { fetchNodeBinary } from './fetch-node-binary.ts';
import { checkPortability } from './check-sea-portability.ts';

// The standalone binary for musl systems — Alpine, and the containers built on it — which the
// deno binary cannot serve (`deno compile` has no musl target) and the glibc SEA cannot start on.
//
// Runs INSIDE an Alpine container (`make build-sea-musl` starts it), because the blob's V8 code
// cache has to be written by the very host it is injected into, and a musl host only runs on musl.
// What comes out is a directory, not one file, since the host alone does not start on bare Alpine:
//
//   qunitx                       the musl Node host + the blob, RUNPATH $ORIGIN/lib
//   lib/libstdc++.so.6           what musl Node links beyond libc, which bare Alpine lacks
//   lib/libgcc_s.so.1
//   esbuild                      the sidecar, as in every other release (a static Go binary)
//   node_modules/playwright-core kept out of the bundle, and with no project to resolve it from
//
// Usage (in the container, from the repo root): node scripts/build-sea-musl.ts <node-version>

const execFileAsync = promisify(execFile);

const ARCH = process.arch;
const TARGET = `linux-${ARCH}-musl`;
const OUT = path.join('dist', `qunitx-${TARGET}`);
const HOST_CACHE = path.join('node_modules', '.cache', 'qunitx', 'node-hosts');

// Same bundle as `make build-sea`: the preamble points esbuild's JS half at the sidecar.
const PREAMBLE =
  ';(function(){if(!process.env.ESBUILD_BINARY_PATH){var path=require("path"),fs=require("fs");' +
  '["esbuild","esbuild.exe"].forEach(function(n){var p=path.join(path.dirname(process.execPath),n);' +
  'try{fs.accessSync(p,fs.constants.X_OK);process.env.ESBUILD_BINARY_PATH=p;}catch(_){}});}})();';

const version = process.argv[2];
if (!version?.startsWith('v')) {
  process.stderr.write('Usage: node scripts/build-sea-musl.ts <node-version, e.g. v24.21.0>\n');
  process.exit(2);
}
if (process.platform !== 'linux' || !isMusl()) {
  process.stderr.write('build-sea-musl.ts runs on musl — use `make build-sea-musl`\n');
  process.exit(2);
}

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'qunitx-sea-musl-'));
try {
  const host = path.resolve(await fetchNodeBinary(version, 'linux', ARCH, 'musl'));
  process.stdout.write(`build-sea-musl: ${TARGET} on ${version} (${host})\n`);

  await esbuild.build({
    entryPoints: ['cli.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    banner: { js: PREAMBLE },
    outfile: path.join(scratch, 'sea-entry.cjs'),
    external: ['fsevents', 'typescript', 'chromium-bidi', 'playwright-core'],
    logLevel: 'warning',
    logOverride: { 'empty-import-meta': 'silent', 'require-resolve-not-external': 'silent' },
  });
  await esbuild.stop();

  const config = path.join(scratch, 'sea-config.json');
  await execFileAsync('node', [path.resolve('scripts/write-sea-config.js')], { cwd: scratch });
  const written = JSON.parse(await fs.readFile(config, 'utf8'));
  // write-sea-config.js names its files relative to the repo root; this runs from scratch.
  for (const name of Object.keys(written.assets)) {
    written.assets[name] = path.resolve(written.assets[name]);
  }
  await fs.writeFile(config, JSON.stringify(written));
  await execFileAsync(host, ['--experimental-sea-config', config], { cwd: scratch });

  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(path.join(OUT, 'lib'), { recursive: true });
  const binary = path.join(OUT, 'qunitx');
  await fs.copyFile(host, binary);
  await fs.chmod(binary, 0o755);
  await execFileAsync('npx', [
    '--yes',
    'postject',
    binary,
    'NODE_SEA_BLOB',
    path.join(scratch, 'sea.blob'),
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ]);
  // After the injection, never before: postject rewriting an ELF that patchelf has already grown
  // leaves an arm64 binary whose dynamic string table points at garbage ("Error loading shared
  // library pecific"). x64 happened to survive that order; this one is correct on both.
  await execFileAsync('patchelf', ['--set-rpath', '$ORIGIN/lib', binary]);

  // Copied through their symlinks: the archive has to carry the libraries, not links to them.
  for (const library of ['libstdc++.so.6', 'libgcc_s.so.1']) {
    await fs.copyFile(await fs.realpath(`/usr/lib/${library}`), path.join(OUT, 'lib', library));
  }
  await fs.copyFile(`node_modules/@esbuild/linux-${ARCH}/bin/esbuild`, path.join(OUT, 'esbuild'));
  await fs.chmod(path.join(OUT, 'esbuild'), 0o755);
  await fs.cp('node_modules/playwright-core', path.join(OUT, 'node_modules', 'playwright-core'), {
    recursive: true,
    dereference: true,
  });

  const verdict = await checkPortability(binary);
  if (!verdict.portable)
    throw new Error(`${binary} is not portable: ${verdict.problems.join('; ')}`);
  const { stdout } = await execFileAsync(binary, ['--version']);
  process.stdout.write(`build-sea-musl: ${OUT} is ready (qunitx ${stdout.trim()})\n`);
} catch (error) {
  // A failed step's command and stderr, said where they can be read: CI job logs need admin
  // rights, but an annotation is on the check run for anyone.
  const failed = error as { message?: string; stderr?: string };
  const said = [failed.message ?? String(error), failed.stderr].filter(Boolean).join('\n');
  process.stderr.write(`build-sea-musl: ${said}\n`);
  if (process.env.GITHUB_ACTIONS) {
    const encoded = said.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    process.stdout.write(`::error title=build-sea-musl ${TARGET}::${encoded}\n`);
  }
  process.exitCode = 1;
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
  // The container runs as root; what it leaves in the bind-mounted repo goes back to its owner,
  // or the next host-side build cannot write beside it.
  const { uid, gid } = await fs.stat('.');
  for (const made of [OUT, HOST_CACHE]) {
    await execFileAsync('chown', ['-R', `${uid}:${gid}`, made]).catch(() => {});
  }
}

/** Whether this process runs on musl — Node's own report leaves out the glibc version there. */
function isMusl(): boolean {
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };

  return report.header?.glibcVersionRuntime === undefined;
}
