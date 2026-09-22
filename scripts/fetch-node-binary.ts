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
 * Which C library the host links. nodejs.org builds against glibc only; the musl builds Alpine
 * needs come from unofficial-builds.nodejs.org — run by the Node.js build team, listed on the
 * download page, and published with the same SHASUMS256.txt this checks against.
 */
export type Libc = 'glibc' | 'musl';

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
 * archiveNameFor('v24.19.0', 'linux', 'x64', 'musl'); // 'node-v24.19.0-linux-x64-musl.tar.gz'
 * ```
 */
export function archiveNameFor(
  version: string,
  platform: string,
  arch: string,
  libc: Libc = 'glibc',
): string {
  if (platform === 'win32') return `node-${version}-win-${arch}.zip`;

  return `node-${version}-${platform}-${arch}${libc === 'musl' ? '-musl' : ''}.tar.gz`;
}

/**
 * Where that archive lives.
 *
 * ```ts
 * import { archiveUrlFor } from './fetch-node-binary.ts';
 *
 * archiveUrlFor('v24.19.0', 'node-v24.19.0-linux-x64.tar.gz');
 * // 'https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.gz'
 * archiveUrlFor('v24.19.0', 'SHASUMS256.txt', 'musl');
 * // 'https://unofficial-builds.nodejs.org/download/release/v24.19.0/SHASUMS256.txt'
 * ```
 */
export function archiveUrlFor(version: string, archive: string, libc: Libc = 'glibc'): string {
  return libc === 'musl'
    ? `https://unofficial-builds.nodejs.org/download/release/${version}/${archive}`
    : `https://nodejs.org/dist/${version}/${archive}`;
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
  libc: Libc = 'glibc',
): Promise<string> {
  const target = `${platform}-${arch}${libc === 'musl' ? '-musl' : ''}`;
  const kept = path.join(CACHE, version, target, platform === 'win32' ? 'node.exe' : 'node');
  if (await readable(kept)) return kept;

  const archive = archiveNameFor(version, platform, arch, libc);
  const manifest = await get(archiveUrlFor(version, 'SHASUMS256.txt', libc)).then((body) =>
    body.toString('utf8'),
  );
  const expected = shaFor(manifest, archive);
  if (expected === null) {
    throw new Error(`no ${archive} is published for ${version} — check the version and target`);
  }

  const body = await get(archiveUrlFor(version, archive, libc));
  const actual = createHash('sha256').update(body).digest('hex');
  if (actual !== expected) {
    throw new Error(`${archive} failed its checksum: expected ${expected}, got ${actual}`);
  }

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'qunitx-node-host-'));
  try {
    const downloaded = path.join(scratch, archive);
    await fs.writeFile(downloaded, body);
    const stem = archive.replace(/\.tar\.gz$|\.zip$/, '');
    await execFileAsync(tarFor(process.platform, process.env), ['-xf', downloaded, '-C', scratch]);

    await fs.mkdir(path.dirname(kept), { recursive: true });
    await fs.copyFile(path.join(scratch, binaryInsideArchive(stem, platform)), kept);
    await fs.chmod(kept, 0o755);

    return kept;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The `tar` that can unpack this platform's archive.
 *
 * Windows ships bsdtar as `System32\\tar.exe`, which reads the `.zip` nodejs.org publishes for it.
 * Taking `tar` from PATH instead finds Git's GNU tar first in Git Bash — which reads `C:\\…` as a
 * remote `host:path` ("Cannot connect to C: resolve failed") and cannot read a zip at all. That
 * failed the Windows SEA build. Elsewhere PATH's `tar` is the right one: bsdtar on macOS, GNU tar
 * on Linux, both reading the `.tar.gz`.
 *
 * ```ts
 * import { tarFor } from './fetch-node-binary.ts';
 *
 * tarFor('win32', { SystemRoot: 'C:\\Windows' }); // 'C:\\Windows\\System32\\tar.exe'
 * tarFor('linux', {}); // 'tar'
 * ```
 */
export function tarFor(platform: string, env: Record<string, string | undefined>): string {
  if (platform !== 'win32') return 'tar';

  return path.win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
}

/**
 * A path as every shell that interpolates it can run it: absolute, with `/` separators.
 *
 * Git Bash treats a command word as a path only if it contains a `/`, so Windows' own
 * `node_modules\\.cache\\…\\node.exe` would be looked up on PATH instead and fail with exit 127.
 * PowerShell, make and every POSIX shell take the `/` form just the same.
 *
 * ```ts
 * import { forShells } from './fetch-node-binary.ts';
 *
 * forShells('D:\\a\\repo\\node.exe', '\\'); // 'D:/a/repo/node.exe'
 * forShells('/home/me/repo/node', '/'); // '/home/me/repo/node'
 * ```
 */
export function forShells(absolute: string, separator: string = path.sep): string {
  return absolute.split(separator).join('/');
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

// `node scripts/fetch-node-binary.ts [version] [platform] [arch] [libc]` prints the path, which is
// what the Makefile and the workflow interpolate. Defaults to this process's own version and
// target, so the binary that gets published is built for the Node this repo is tested on.
if (process.argv[1]?.endsWith('fetch-node-binary.ts')) {
  const [version = process.version, platform = process.platform, arch = process.arch, libc] =
    process.argv.slice(2);

  const host = await fetchNodeBinary(version, platform, arch, libc === 'musl' ? 'musl' : 'glibc');
  process.stdout.write(forShells(path.resolve(host)));
}
