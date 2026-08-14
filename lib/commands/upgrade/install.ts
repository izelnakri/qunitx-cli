import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Failure } from '../../result/index.ts';
import { parseChecksums, type Release } from './release.ts';

// Replacing a running executable, once the release is known. Everything that talks to the network
// or the filesystem arrives through `InstallDeps`, so every failure below is reachable in a test
// without a release, a download, or a real binary.

/**
 * The release has no asset for this platform — a `deno compile` build asking for a target only
 * the SEA matrix publishes, or the reverse.
 *
 * ```ts
 * import * as Install from './install.ts';
 *
 * Install.AssetMissing({ asset: 'qunitx-macos-x64.tar.gz', tag: 'v1.0.0' }).code; // 'UpgradeAssetMissing'
 * ```
 */
export const AssetMissing: Failure.FailureFactory<
  'UpgradeAssetMissing',
  { asset: string; tag: string }
> = Failure.define(
  'UpgradeAssetMissing',
  (data: { asset: string; tag: string }) =>
    `Release ${data.tag} publishes no ${data.asset} — this platform has no prebuilt binary in it.`,
);

/**
 * The release publishes no `checksums.txt`, so the download cannot be verified. Refused rather
 * than downgraded to a warning: an unverified binary replacing the one you are running is
 * exactly the thing worth refusing.
 *
 * ```ts
 * import * as Install from './install.ts';
 *
 * Install.ChecksumsMissing({ tag: 'v0.1.0' }).code; // 'UpgradeChecksumsMissing'
 * ```
 */
export const ChecksumsMissing: Failure.FailureFactory<'UpgradeChecksumsMissing', { tag: string }> =
  Failure.define(
    'UpgradeChecksumsMissing',
    (data: { tag: string }) =>
      `Release ${data.tag} publishes no checksums.txt — refusing to install an unverified binary.`,
  );

/**
 * The downloaded bytes do not hash to what the release published — a corrupted or truncated
 * transfer, or a tampered asset. Nothing has been replaced when this is thrown.
 *
 * ```ts
 * import * as Install from './install.ts';
 *
 * Install.ChecksumMismatch({ asset: 'a.tar.gz', expected: 'aa', actual: 'bb' }).code; // 'UpgradeChecksumMismatch'
 * ```
 */
export const ChecksumMismatch: Failure.FailureFactory<
  'UpgradeChecksumMismatch',
  { asset: string; expected: string; actual: string }
> = Failure.define(
  'UpgradeChecksumMismatch',
  (data: { asset: string; expected: string; actual: string }) =>
    `Checksum mismatch for ${data.asset}: expected ${data.expected}, got ${data.actual}. Nothing was replaced.`,
);

/**
 * The download itself failed — an HTTP error or a dead connection mid-transfer.
 *
 * ```ts
 * import * as Install from './install.ts';
 *
 * Install.DownloadFailed({ url: 'https://example.test/a', reason: '502' }).code; // 'UpgradeDownloadFailed'
 * ```
 */
export const DownloadFailed: Failure.FailureFactory<
  'UpgradeDownloadFailed',
  { url: string; reason: string }
> = Failure.define(
  'UpgradeDownloadFailed',
  (data: { url: string; reason: string }) => `Download of ${data.url} failed: ${data.reason}`,
);

/**
 * The directory holding the binary is not writable by this user — the usual case being a
 * root-owned prefix such as `/usr/local/bin`.
 *
 * ```ts
 * import * as Install from './install.ts';
 *
 * Install.TargetNotWritable({ dir: '/usr/local/bin' }).code; // 'UpgradeTargetNotWritable'
 * ```
 */
export const TargetNotWritable: Failure.FailureFactory<
  'UpgradeTargetNotWritable',
  { dir: string }
> = Failure.define(
  'UpgradeTargetNotWritable',
  (data: { dir: string }) =>
    `${data.dir} is not writable by this user — re-run with elevated permissions, or reinstall into a directory you own.`,
);

/**
 * The replace itself failed, after the new binary was downloaded and verified. Carries the
 * recovery path when the old binary had to be moved aside first.
 *
 * ```ts
 * import * as Install from './install.ts';
 *
 * Install.ReplaceFailed({ target: '/opt/qunitx/qunitx', reason: 'EPERM' }).code; // 'UpgradeReplaceFailed'
 * ```
 */
export const ReplaceFailed: Failure.FailureFactory<
  'UpgradeReplaceFailed',
  { target: string; reason: string; recovered?: string }
> = Failure.define(
  'UpgradeReplaceFailed',
  (data: { target: string; reason: string; recovered?: string }) =>
    `Could not replace ${data.target}: ${data.reason}.` +
    (data.recovered ? ` The previous binary is back in place (${data.recovered}).` : ''),
);

/**
 * What to install, and over what.
 *
 * ```ts
 * import type { InstallPlan } from './install.ts';
 *
 * const plan: InstallPlan = {
 *   release: { tag: 'v1.0.0', version: '1.0.0', assets: [] },
 *   assetName: 'qunitx-deno-linux-x64.tar.gz',
 *   binaryPath: '/opt/qunitx/qunitx',
 * };
 * plan.assetName; // the archive whose contents replace plan.binaryPath
 * ```
 */
export interface InstallPlan {
  /** The release to install, as {@link Release} `find` returned it. */
  release: Release;
  /** The archive to download from it. */
  assetName: string;
  /** The running executable to replace, and whose directory receives the sidecar. */
  binaryPath: string;
  /** Path and replace semantics to apply. Defaults to the host's. */
  platform?: NodeJS.Platform;
}

/**
 * The seams {@link apply} reaches the world through. All three default to the real thing.
 *
 * ```ts
 * import type { InstallDeps } from './install.ts';
 *
 * const deps: InstallDeps = { access: () => Promise.reject(new Error('EACCES')) };
 * deps.access !== undefined; // true — a read-only install directory, with no chmod in sight
 * ```
 */
export interface InstallDeps {
  /** Fetches the checksum file and the archive. */
  fetch?: typeof fetch;
  /** Unpacks the archive into a directory. Defaults to {@link extract}. */
  extract?: (archivePath: string, destination: string) => Promise<void>;
  /** Rejects when the install directory cannot be written. Defaults to `fs.access(dir, W_OK)`. */
  access?: (directory: string) => Promise<void>;
}

/**
 * Downloads the release archive, verifies it against the release's `checksums.txt`, and replaces
 * the running binary (and its esbuild sidecar, when the install has one).
 *
 * Nothing on disk is touched until the bytes are verified, and the replace itself is one atomic
 * rename per file, so an interrupted upgrade leaves a working binary either way.
 *
 * ```ts
 * import * as Install from './install.ts';
 * import type { InstallPlan } from './install.ts';
 *
 * // Defined, not invoked: downloads a release and rewrites files on disk.
 * async function upgradeBinary(plan: InstallPlan) {
 *   return await Install.apply(plan); // ['/opt/qunitx/qunitx', '/opt/qunitx/esbuild']
 * }
 * ```
 *
 * @returns the absolute paths it replaced, binary first.
 */
export async function apply(plan: InstallPlan, deps: InstallDeps = {}): Promise<string[]> {
  const platform = plan.platform ?? process.platform;
  const fetchImpl = deps.fetch ?? fetch;
  // Paths are built with the HOST's rules, never with `platform`: the binary being replaced is a
  // real file on this machine. `platform` says which archive to unpack and which replace rule to
  // follow — the two only ever differ in a test, and treating them as one turned every path here
  // into a relative one on Windows (staging landed on another drive, and the rename hit EXDEV).
  const directory = path.dirname(plan.binaryPath);
  const asset = plan.release.assets.find((candidate) => candidate.name === plan.assetName);
  const checksums = plan.release.assets.find((candidate) => candidate.name === 'checksums.txt');

  if (!asset) throw AssetMissing({ asset: plan.assetName, tag: plan.release.tag });
  else if (!checksums) throw ChecksumsMissing({ tag: plan.release.tag });

  // Asked before the download rather than discovered by a failing rename: a root-owned prefix is
  // the common case, and 40MB of transfer should not precede the news. (On Windows W_OK on a
  // directory says little; a permission failure there surfaces as ReplaceFailed instead.)
  await (deps.access ?? ((target: string) => fs.access(target, constants.W_OK)))(directory).catch(
    () => {
      throw TargetNotWritable({ dir: directory });
    },
  );

  const expected = parseChecksums(await download(checksums.url, fetchImpl, 'text')).get(
    plan.assetName,
  );
  if (!expected) throw ChecksumsMissing({ tag: plan.release.tag });

  // A truncated transfer is a wrong hash, so the partial-download case needs no separate handling.
  const bytes = await download(asset.url, fetchImpl, 'bytes');
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    throw ChecksumMismatch({ asset: plan.assetName, expected, actual });
  }

  // Staged INSIDE the install directory, because the replace is a rename and a rename is only
  // atomic within one filesystem — os.tmpdir() is regularly a different one.
  const staging = await fs.mkdtemp(path.join(directory, '.qunitx-upgrade-'));
  try {
    const archivePath = path.join(staging, plan.assetName);
    await fs.writeFile(archivePath, bytes);
    await (deps.extract ?? extract)(archivePath, staging);

    const unpacked = path.join(staging, plan.assetName.replace(/\.(tar\.gz|zip)$/, ''));
    const binaryName = platform === 'win32' ? 'qunitx.exe' : 'qunitx';
    const sidecarName = platform === 'win32' ? 'esbuild.exe' : 'esbuild';
    const sidecarPath = path.join(directory, sidecarName);
    const replaced: string[] = [];

    // Sidecar first, binary last, and only when the install already has one: esbuild's JS half
    // version-checks the executable it spawns, so the pair must not be left crossed. The window
    // between the two renames is microseconds, and a failure in the second rolls the first back.
    const sidecarBackup = path.join(staging, `${sidecarName}.previous`);
    const hasSidecar = await exists(sidecarPath);
    if (hasSidecar && (await exists(path.join(unpacked, sidecarName)))) {
      await fs.copyFile(sidecarPath, sidecarBackup);
      await makeExecutable(path.join(unpacked, sidecarName), platform);
      await fs.rename(path.join(unpacked, sidecarName), sidecarPath);
      replaced.push(sidecarPath);
    }

    await makeExecutable(path.join(unpacked, binaryName), platform);
    await swapBinary(path.join(unpacked, binaryName), plan.binaryPath, platform).catch(
      async (error: unknown) => {
        if (replaced.length > 0) await fs.rename(sidecarBackup, sidecarPath).catch(() => {});
        throw error;
      },
    );

    return [plan.binaryPath, ...replaced];
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Puts `staged` at `target`, honouring the one platform rule that matters: POSIX replaces a
 * running executable with an atomic rename (the running process keeps its inode), while Windows
 * cannot unlink a running image at all — so the old file is renamed aside first, and renamed back
 * if anything goes wrong.
 *
 * ```ts
 * import * as Install from './install.ts';
 *
 * // Defined, not invoked: renames files on disk.
 * async function swap() {
 *   await Install.swapBinary('/opt/qunitx/.staged/qunitx', '/opt/qunitx/qunitx', 'linux');
 * }
 * ```
 */
export async function swapBinary(
  staged: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== 'win32') {
    return await fs
      .rename(staged, target)
      .catch((error: unknown) => {
        throw ReplaceFailed({ target, reason: reasonOf(error) });
      })
      .then(() => undefined);
  }

  // Windows: renaming a running image is allowed, deleting it is not. The parked copy is removed
  // by the NEXT upgrade (sweepParked), once it is no longer the running process.
  const parked = `${target}.old-${Date.now()}`;
  await fs.rename(target, parked).catch((error: unknown) => {
    throw ReplaceFailed({ target, reason: reasonOf(error) });
  });
  await fs.rename(staged, target).catch(async (error: unknown) => {
    const restored = await fs
      .rename(parked, target)
      .then(() => true)
      .catch(() => false);
    throw ReplaceFailed({
      target,
      reason: reasonOf(error),
      recovered: restored ? target : parked,
    });
  });
  await sweepParked(target);
}

/**
 * Unpacks a release archive with the host's `tar` / `unzip`, falling back to PowerShell's
 * `Expand-Archive` where a Windows shell has no `unzip` — the same two-step jsr/cli.ts uses,
 * for the same reason: no JS extractor has to ship inside the binary.
 *
 * ```ts
 * import * as Install from './install.ts';
 *
 * // Defined, not invoked: spawns tar and writes to disk.
 * async function unpack() {
 *   await Install.extract('/tmp/qunitx-deno-linux-x64.tar.gz', '/tmp/staging');
 * }
 * ```
 */
export async function extract(archivePath: string, destination: string): Promise<void> {
  if (!archivePath.endsWith('.zip')) {
    return await run('tar', ['xzf', archivePath, '-C', destination]);
  }

  const unzipped = await run('unzip', ['-q', archivePath, '-d', destination]).then(
    () => true,
    () => false,
  );
  if (!unzipped) {
    await run('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path '${archivePath}' -DestinationPath '${destination}' -Force`,
    ]);
  }
}

async function download(url: string, fetchImpl: typeof fetch, as: 'text'): Promise<string>;
async function download(url: string, fetchImpl: typeof fetch, as: 'bytes'): Promise<Uint8Array>;
async function download(
  url: string,
  fetchImpl: typeof fetch,
  as: 'text' | 'bytes',
): Promise<string | Uint8Array> {
  const response = await fetchImpl(url).catch((error: unknown) => {
    throw DownloadFailed({ url, reason: reasonOf(error) });
  });
  if (!response.ok) {
    throw DownloadFailed({ url, reason: `${response.status} ${response.statusText}` });
  }

  if (as === 'text') {
    return await response.text().catch((error: unknown) => {
      throw DownloadFailed({ url, reason: reasonOf(error) });
    });
  }

  return await response
    .arrayBuffer()
    .then((buffer) => new Uint8Array(buffer))
    .catch((error: unknown) => {
      throw DownloadFailed({ url, reason: reasonOf(error) });
    });
}

// Leftovers from a previous Windows upgrade, which could not be deleted while they were the
// running image. Best-effort: one still-locked file must not fail an upgrade that succeeded.
async function sweepParked(target: string): Promise<void> {
  const directory = path.dirname(target);
  const prefix = `${path.basename(target)}.old-`;
  const entries = await fs.readdir(directory).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => fs.rm(path.join(directory, entry), { force: true }).catch(() => {})),
  );
}

async function makeExecutable(target: string, platform: NodeJS.Platform): Promise<void> {
  if (platform !== 'win32') await fs.chmod(target, 0o755).catch(() => {});
}

function exists(target: string): Promise<boolean> {
  return fs.access(target).then(
    () => true,
    () => false,
  );
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
