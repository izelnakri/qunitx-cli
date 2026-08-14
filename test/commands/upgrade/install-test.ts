import { module, test } from 'qunitx';
import process from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as Install from '../../../lib/commands/upgrade/install.ts';
import { Failure } from '../../../lib/result/index.ts';
import { tempDir } from '../../helpers/temp-dir.ts';
import { rmRetry } from '../../helpers/rm-retry.ts';
import '../../helpers/custom-asserts.ts';

// The replace, end to end, against real files in a temp directory — with the download and the
// writability probe injected, so the paths that matter (a bad checksum, a read-only prefix, a
// replace that fails halfway) are deterministic and nothing leaves this machine.

const ASSET = 'qunitx-deno-linux-x64.tar.gz';
const ARCHIVE = new TextEncoder().encode('pretend-tarball-bytes');
const DIGEST = createHash('sha256').update(ARCHIVE).digest('hex');
const CHECKSUMS_URL = 'https://dl.test/checksums.txt';
const ASSET_URL = `https://dl.test/${ASSET}`;

const release = (
  assets: { name: string; url: string }[] = [
    { name: 'checksums.txt', url: CHECKSUMS_URL },
    { name: ASSET, url: ASSET_URL },
  ],
) => ({ tag: 'v0.35.0', version: '0.35.0', assets });

// Serves the checksum file and the archive; records every URL asked for, so "did it download
// before it discovered it could not install" is an assertable question.
function downloads(
  requested: string[],
  { checksums = `${DIGEST}  ${ASSET}\n`, bytes = ARCHIVE, status = 200 } = {},
): typeof fetch {
  return ((url: string) => {
    requested.push(url);
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: 'Error',
      text: () => Promise.resolve(checksums),
      arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0)),
    });
  }) as unknown as typeof fetch;
}

// Stands in for `tar xzf`: writes the archive's documented layout,
// `<asset-without-extension>/{qunitx,esbuild}`, into the staging directory.
const unpacks = (files: Record<string, string>) => async (archivePath: string, dest: string) => {
  const inner = path.join(dest, path.basename(archivePath).replace(/\.(tar\.gz|zip)$/, ''));
  await fs.mkdir(inner, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(inner, name), content);
  }
};

const read = (file: string) => fs.readFile(file, 'utf8');

module('Commands | Upgrade | Install.apply', { concurrency: true }, () => {
  test('replaces the binary and its esbuild sidecar, and leaves no staging behind', async (assert) => {
    await using dir = await tempDir('upgrade-apply');
    const binary = path.join(dir.path, 'qunitx');
    const sidecar = path.join(dir.path, 'esbuild');
    await fs.writeFile(binary, 'old-binary');
    await fs.writeFile(sidecar, 'old-esbuild');

    const replaced = await Install.apply(
      { release: release(), assetName: ASSET, binaryPath: binary, platform: 'linux' },
      { fetch: downloads([]), extract: unpacks({ qunitx: 'new-binary', esbuild: 'new-esbuild' }) },
    );

    assert.deepEqual(replaced, [binary, sidecar]);
    assert.strictEqual(await read(binary), 'new-binary');
    assert.strictEqual(await read(sidecar), 'new-esbuild');
    // Only on a POSIX host: NTFS has no execute bit, and Windows' chmod moves the read-only flag
    // and nothing else — the mode would read the same whether or not the chmod ever happened.
    if (process.platform !== 'win32') {
      assert.strictEqual(
        (await fs.stat(binary)).mode & 0o111,
        0o111,
        'the new binary is executable',
      );
    }
    assert.deepEqual(
      (await fs.readdir(dir.path)).sort(),
      ['esbuild', 'qunitx'],
      'the staging directory is gone',
    );
  });

  test('an install with no sidecar gets only its binary replaced', async (assert) => {
    await using dir = await tempDir('upgrade-no-sidecar');
    const binary = path.join(dir.path, 'qunitx');
    await fs.writeFile(binary, 'old-binary');

    const replaced = await Install.apply(
      { release: release(), assetName: ASSET, binaryPath: binary, platform: 'linux' },
      { fetch: downloads([]), extract: unpacks({ qunitx: 'new-binary', esbuild: 'new-esbuild' }) },
    );

    assert.deepEqual(replaced, [binary]);
    assert.deepEqual(await fs.readdir(dir.path), ['qunitx'], 'no sidecar is introduced');
  });

  test('the Windows shape replaces qunitx.exe out of a .zip, on whatever host runs this', async (assert) => {
    // `platform` chooses the archive and the replace rule; the paths themselves are always the
    // host's. Forcing the two apart is what proved they were entangled — on a Windows runner the
    // POSIX-forced tests above built relative paths, staged onto another drive, and hit EXDEV.
    await using dir = await tempDir('upgrade-win32-shape');
    const zipAsset = 'qunitx-deno-windows-x64.zip';
    const binary = path.join(dir.path, 'qunitx.exe');
    await fs.writeFile(binary, 'old-binary');

    const replaced = await Install.apply(
      {
        release: release([
          { name: 'checksums.txt', url: CHECKSUMS_URL },
          { name: zipAsset, url: `https://dl.test/${zipAsset}` },
        ]),
        assetName: zipAsset,
        binaryPath: binary,
        platform: 'win32',
      },
      {
        fetch: downloads([], { checksums: `${DIGEST}  ${zipAsset}\n` }),
        extract: unpacks({ 'qunitx.exe': 'new-binary' }),
      },
    );

    assert.deepEqual(replaced, [binary]);
    assert.strictEqual(await read(binary), 'new-binary');
    assert.deepEqual(await fs.readdir(dir.path), ['qunitx.exe'], 'the parked copy is swept');
  });

  test('a checksum that does not match leaves the old binary exactly where it was', async (assert) => {
    await using dir = await tempDir('upgrade-mismatch');
    const binary = path.join(dir.path, 'qunitx');
    await fs.writeFile(binary, 'old-binary');

    const failure = await Install.apply(
      { release: release(), assetName: ASSET, binaryPath: binary, platform: 'linux' },
      {
        fetch: downloads([], { checksums: `${'0'.repeat(64)}  ${ASSET}\n` }),
        extract: unpacks({ qunitx: 'new-binary' }),
      },
    ).catch((error: unknown) => error);

    assert.ok(Failure.is(failure) && failure.code === 'UpgradeChecksumMismatch');
    assert.strictEqual(await read(binary), 'old-binary');
    assert.deepEqual(await fs.readdir(dir.path), ['qunitx'], 'nothing was staged or left behind');
  });

  test('a release without an asset for this platform is refused before anything is fetched', async (assert) => {
    await using dir = await tempDir('upgrade-no-asset');
    const requested: string[] = [];

    const failure = await Install.apply(
      {
        release: release([{ name: 'checksums.txt', url: CHECKSUMS_URL }]),
        assetName: ASSET,
        binaryPath: path.join(dir.path, 'qunitx'),
        platform: 'linux',
      },
      { fetch: downloads(requested), extract: unpacks({}) },
    ).catch((error: unknown) => error);

    assert.ok(Failure.is(failure) && failure.code === 'UpgradeAssetMissing');
    assert.deepEqual(requested, [], 'no download is attempted for an asset that is not there');
  });

  test('a release publishing no checksums.txt is refused rather than installed unverified', async (assert) => {
    await using dir = await tempDir('upgrade-no-checksums');

    const failure = await Install.apply(
      {
        release: release([{ name: ASSET, url: ASSET_URL }]),
        assetName: ASSET,
        binaryPath: path.join(dir.path, 'qunitx'),
        platform: 'linux',
      },
      { fetch: downloads([]), extract: unpacks({}) },
    ).catch((error: unknown) => error);

    assert.ok(Failure.is(failure) && failure.code === 'UpgradeChecksumsMissing');
  });

  test('a checksums.txt with no line for this asset counts as no checksum at all', async (assert) => {
    await using dir = await tempDir('upgrade-checksum-gap');
    const binary = path.join(dir.path, 'qunitx');
    await fs.writeFile(binary, 'old-binary');

    const failure = await Install.apply(
      { release: release(), assetName: ASSET, binaryPath: binary, platform: 'linux' },
      {
        fetch: downloads([], { checksums: `${DIGEST}  some-other-file.zip\n` }),
        extract: unpacks({ qunitx: 'new-binary' }),
      },
    ).catch((error: unknown) => error);

    assert.ok(Failure.is(failure) && failure.code === 'UpgradeChecksumsMissing');
    assert.strictEqual(await read(binary), 'old-binary');
  });

  test('a root-owned install directory is reported before 40MB is downloaded', async (assert) => {
    await using dir = await tempDir('upgrade-readonly');
    const requested: string[] = [];

    const failure = await Install.apply(
      {
        release: release(),
        assetName: ASSET,
        binaryPath: path.join(dir.path, 'qunitx'),
        platform: 'linux',
      },
      {
        fetch: downloads(requested),
        extract: unpacks({}),
        access: () => Promise.reject(new Error('EACCES: permission denied')),
      },
    ).catch((error: unknown) => error);

    assert.ok(Failure.is(failure) && failure.code === 'UpgradeTargetNotWritable');
    assert.includes(Failure.format(failure), dir.path);
    assert.deepEqual(requested, [], 'the news comes first, not after the transfer');
  });

  test('an HTTP error mid-download is a declared failure', async (assert) => {
    await using dir = await tempDir('upgrade-http-error');

    const failure = await Install.apply(
      {
        release: release(),
        assetName: ASSET,
        binaryPath: path.join(dir.path, 'qunitx'),
        platform: 'linux',
      },
      { fetch: downloads([], { status: 502 }), extract: unpacks({}) },
    ).catch((error: unknown) => error);

    assert.ok(Failure.is(failure) && failure.code === 'UpgradeDownloadFailed');
  });

  test('a replace that fails halfway rolls the sidecar back and keeps the old binary', async (assert) => {
    await using dir = await tempDir('upgrade-interrupted');
    const binary = path.join(dir.path, 'qunitx');
    const sidecar = path.join(dir.path, 'esbuild');
    await fs.writeFile(binary, 'old-binary');
    await fs.writeFile(sidecar, 'old-esbuild');

    // An archive whose binary never materialises — the shape of a truncated unpack, and the one
    // ordering that matters: the sidecar has already been swapped when the binary rename fails.
    const failure = await Install.apply(
      { release: release(), assetName: ASSET, binaryPath: binary, platform: 'linux' },
      { fetch: downloads([]), extract: unpacks({ esbuild: 'new-esbuild' }) },
    ).catch((error: unknown) => error);

    assert.ok(Failure.is(failure) && failure.code === 'UpgradeReplaceFailed');
    assert.strictEqual(await read(binary), 'old-binary', 'the working binary is still working');
    assert.strictEqual(await read(sidecar), 'old-esbuild', 'and the pair is not left crossed');
    assert.deepEqual((await fs.readdir(dir.path)).sort(), ['esbuild', 'qunitx']);
  });
});

module('Commands | Upgrade | Install.swapBinary', { concurrency: true }, () => {
  test('POSIX replaces in one atomic rename', async (assert) => {
    await using dir = await tempDir('upgrade-swap-posix');
    const target = path.join(dir.path, 'qunitx');
    const staged = path.join(dir.path, 'staged');
    await fs.writeFile(target, 'old');
    await fs.writeFile(staged, 'new');

    await Install.swapBinary(staged, target, 'linux');

    assert.strictEqual(await read(target), 'new');
    assert.deepEqual(await fs.readdir(dir.path), ['qunitx'], 'no parked copy is left on POSIX');
  });

  test('Windows parks the running image instead of unlinking it, and sweeps older parks', async (assert) => {
    await using dir = await tempDir('upgrade-swap-win32');
    const target = path.join(dir.path, 'qunitx.exe');
    const staged = path.join(dir.path, 'staged.exe');
    await fs.writeFile(target, 'old');
    await fs.writeFile(staged, 'new');
    await fs.writeFile(`${target}.old-1`, 'from a previous upgrade');

    await Install.swapBinary(staged, target, 'win32');

    assert.strictEqual(await read(target), 'new');
    assert.deepEqual(
      await fs.readdir(dir.path),
      ['qunitx.exe'],
      'the leftover the last upgrade could not delete is gone',
    );
  });

  test('a Windows replace that fails puts the previous binary back', async (assert) => {
    await using dir = await tempDir('upgrade-swap-rollback');
    const target = path.join(dir.path, 'qunitx.exe');
    await fs.writeFile(target, 'old');

    const failure = await Install.swapBinary(
      path.join(dir.path, 'never-extracted.exe'),
      target,
      'win32',
    ).catch((error: unknown) => error);

    assert.ok(Failure.is(failure) && failure.code === 'UpgradeReplaceFailed');
    assert.includes(Failure.format(failure), 'previous binary is back in place');
    assert.strictEqual(await read(target), 'old', 'never left without a working qunitx');
  });
});

module('Commands | Upgrade | Install.extract', { concurrency: true }, () => {
  test('unpacks a real tar.gz through the host tar', async (assert) => {
    if (process.platform === 'win32') {
      // The zip half of this function goes through unzip / Expand-Archive, which is exercised by
      // the release-install-sh test in CI rather than here.
      return assert.ok(true, 'skipped on Windows: the .zip path needs a zip, not a tarball');
    }

    await using dir = await tempDir('upgrade-extract');
    const payload = path.join(dir.path, 'qunitx-deno-linux-x64');
    await fs.mkdir(payload);
    await fs.writeFile(path.join(payload, 'qunitx'), 'binary');
    const { spawnSync } = await import('node:child_process');
    spawnSync('tar', ['czf', path.join(dir.path, ASSET), '-C', dir.path, 'qunitx-deno-linux-x64']);
    // rmRetry, not a bare recursive rm: this file spawns a child, and the repo's guard in
    // test/helpers/rm-retry-test.ts holds every such test to the retrying removal.
    await rmRetry(payload);

    await Install.extract(path.join(dir.path, ASSET), dir.path);

    assert.strictEqual(await read(path.join(payload, 'qunitx')), 'binary');
  });
});
