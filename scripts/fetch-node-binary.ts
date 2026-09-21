import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// The Node executable a SEA binary is built ON TOP of, fetched from nodejs.org rather than taken
// from this machine.
//
// `make build-sea` used to copy `process.execPath`, which makes the published binary a property of
// the machine that released it. On NixOS that machine's Node has an ELF interpreter inside
// /nix/store, so the binary published to npm could not start anywhere else: `execve` fails in the
// kernel before a byte of JavaScript runs, and the launcher exits with no output at all. Measured
// on qunitx-cli-linux-x64@0.36.0:
//
//   interpreter  /nix/store/m07h…-glibc-2.42-67/lib/ld-linux-x86-64.so.2
//   NEEDED       26 libraries, including libicui18n, libssl, libsqlite3, libada, libsimdjson
//   RUNPATH      19 /nix/store paths
//
// An official build has a standard interpreter, six well-known libraries, no RUNPATH, and needs
// only glibc 2.28 — older than any supported distribution. So the host is downloaded and checked
// against the release's own SHASUMS256.txt, and where it was built stops mattering.

const execFileAsync = promisify(execFile);

/** Where the downloaded hosts are kept — beside the compile cache, outside `tmp/`'s scrub. */
const CACHE = path.join('node_modules', '.cache', 'qunitx', 'node-hosts');

/**
 * What nodejs.org calls the archive for one version and target.
 *
 * Windows ships a `.zip`; everything else a `.tar.gz`. The `.tar.xz` is smaller and needs `xz`,
 * which is one more thing to be missing on a release machine.
 *
 * ```ts
 * import { archiveNameFor } from './fetch-node-binary.ts';
 *
 * archiveNameFor('v24.19.0', 'linux', 'x64'); // 'node-v24.19.0-linux-x64.tar.gz'
 * archiveNameFor('v24.19.0', 'darwin', 'arm64'); // 'node-v24.19.0-darwin-arm64.tar.gz'
 * archiveNameFor('v24.19.0', 'win32', 'x64'); // 'node-v24.19.0-win-x64.zip'
 * ```
 */
export function archiveNameFor(version: string, platform: string, arch: string): string {
  if (platform === 'win32') return `node-${version}-win-${arch}.zip`;

  return `node-${version}-${platform}-${arch}.tar.gz`;
}

/**
 * Where that archive lives.
 *
 * ```ts
 * import { archiveUrlFor } from './fetch-node-binary.ts';
 *
 * archiveUrlFor('v24.19.0', 'node-v24.19.0-linux-x64.tar.gz');
 * // 'https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.gz'
 * ```
 */
export function archiveUrlFor(version: string, archive: string): string {
  return `https://nodejs.org/dist/${version}/${archive}`;
}

/**
 * The checksum `SHASUMS256.txt` publishes for one archive, or `null` where it names no such file.
 *
 * Parsed rather than grepped so that a version whose manifest does not mention the archive fails
 * by name instead of downloading something unverified.
 *
 * ```ts
 * import { shaFor } from './fetch-node-binary.ts';
 *
 * const manifest = 'aaa  node-v1-linux-x64.tar.gz\nbbb  node-v1-darwin-arm64.tar.gz\n';
 * shaFor(manifest, 'node-v1-darwin-arm64.tar.gz'); // 'bbb'
 * shaFor(manifest, 'node-v1-win-x64.zip'); // null
 * ```
 */
export function shaFor(manifest: string, archive: string): string | null {
  for (const line of manifest.split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === archive && sha !== undefined) return sha;
  }

  return null;
}

/**
 * Where `bin/node` sits inside the extracted archive.
 *
 * ```ts
 * import { binaryInsideArchive } from './fetch-node-binary.ts';
 *
 * binaryInsideArchive('node-v1-linux-x64', 'linux'); // 'node-v1-linux-x64/bin/node'
 * binaryInsideArchive('node-v1-win-x64', 'win32'); // 'node-v1-win-x64/node.exe'
 * ```
 */
export function binaryInsideArchive(stem: string, platform: string): string {
  return platform === 'win32' ? `${stem}/node.exe` : `${stem}/bin/node`;
}

/**
 * Fetches the official Node executable for a target, verifies it, and answers with its path.
 *
 * Cached by version and target, because a release runs this once per platform and a 50MB download
 * per invocation would be the slowest part of cutting one.
 *
 * ```ts
 * import { fetchNodeBinary } from './fetch-node-binary.ts';
 *
 * // Defined, not invoked: it reaches nodejs.org.
 * function example() {
 *   return fetchNodeBinary('v24.19.0', 'linux', 'x64'); // '…/node-hosts/v24.19.0/linux-x64/node'
 * }
 * ```
 */
export async function fetchNodeBinary(
  version: string,
  platform: string,
  arch: string,
): Promise<string> {
  const target = `${platform}-${arch}`;
  const kept = path.join(CACHE, version, target, platform === 'win32' ? 'node.exe' : 'node');
  if (await readable(kept)) return kept;

  const archive = archiveNameFor(version, platform, arch);
  const manifest = await get(archiveUrlFor(version, 'SHASUMS256.txt')).then((body) =>
    body.toString('utf8'),
  );
  const expected = shaFor(manifest, archive);
  if (expected === null) {
    throw new Error(`nodejs.org has no ${archive} for ${version} — check the version and target`);
  }

  const body = await get(archiveUrlFor(version, archive));
  const actual = createHash('sha256').update(body).digest('hex');
  if (actual !== expected) {
    throw new Error(`${archive} failed its checksum: expected ${expected}, got ${actual}`);
  }

  // Unpacked with the system `tar`, which reads both .tar.gz and .zip on every platform this
  // releases from — bsdtar on macOS and Windows 10+, GNU tar on Linux.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'qunitx-node-host-'));
  try {
    const downloaded = path.join(scratch, archive);
    await fs.writeFile(downloaded, body);
    const stem = archive.replace(/\.tar\.gz$|\.zip$/, '');
    await execFileAsync('tar', ['-xf', downloaded, '-C', scratch]);

    await fs.mkdir(path.dirname(kept), { recursive: true });
    await fs.copyFile(path.join(scratch, binaryInsideArchive(stem, platform)), kept);
    await fs.chmod(kept, 0o755);

    return kept;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

/** One GET, as bytes, refusing anything but a 200 by name. */
async function get(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status} ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/** Whether a cached host is there and runnable. */
async function readable(file: string): Promise<boolean> {
  try {
    await fs.access(file, fs.constants.X_OK);

    return true;
  } catch {
    return false;
  }
}

// `node scripts/fetch-node-binary.ts [version] [platform] [arch]` prints the path, which is what
// the Makefile and the workflow interpolate. Defaults to this process's own version and target, so
// the binary that gets published is built for the Node this repo is tested on.
if (process.argv[1]?.endsWith('fetch-node-binary.ts')) {
  const [version = process.version, platform = process.platform, arch = process.arch] =
    process.argv.slice(2);

  process.stdout.write(await fetchNodeBinary(version, platform, arch));
}
