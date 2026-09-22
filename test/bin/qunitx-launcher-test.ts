import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { module, test } from 'qunitx';
import {
  archiveNameFor,
  archiveUrlFor,
  binaryInsideArchive,
  forShells,
  tarFor,
  shaFor,
} from '../../scripts/fetch-node-binary.ts';
import { elfNaming } from '../helpers/tiny-elf.ts';
import { rmRetry } from '../helpers/rm-retry.ts';
import { spawnCapture } from '../helpers/shell.ts';
import '../helpers/custom-asserts.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

// The package the launcher looks for on THIS machine — hard-coded to linux-x64, the test planted a
// package an arm64 launcher never asks for, so it fell back silently and the note never came.
const PLATFORM_PACKAGE = `qunitx-cli-linux-${process.arch}`;

// `bin/qunitx.js` prefers a prebuilt SEA binary from the matching platform package and falls back
// to the bundled JS CLI. It used to fall back only when that package was ABSENT — a binary that
// was present and could not start took the process down with exit 254 and no output at all, which
// is what made the original bug so hard to place.

module('Bin | the launcher | a binary that cannot start', { concurrency: true }, () => {
  if (process.platform !== 'linux') {
    test('skipped: the failure being reproduced is an ELF one', (assert) => {
      assert.ok(true);
    });
  }

  if (process.platform === 'linux') {
    // One test, one planting: the package has to be installed under its real name for
    // `require.resolve` to find it, so two tests doing this at once would fight over the path.
    test('falls back to the JS CLI instead of dying with 254, and says why', async (assert) => {
      await ensureBundledCli();
      await using planted = await plantBrokenPlatformPackage();
      // `--version` because it is the one flag that answers without needing inputs, a browser or
      // a project — so a non-zero exit here means the launcher, not the run.
      const result = await spawnCapture(
        `node ${path.join(repoRoot, 'bin', 'qunitx.js')} --version`,
        { cwd: repoRoot },
      );

      // Both halves matter. 254 is what `process.exit(-2)` from the `close` handler produced —
      // it killed the fallback that the `error` handler had just started — and an empty stdout
      // is what made it undiagnosable.
      assert.exitCode(result, 0);
      assert.includes(result, planted.version, 'the JS CLI answered, with the version');
      assert.strictEqual(planted.kind, 'broken-elf', 'and the binary really was unrunnable');

      // Said once, on stderr. A silent fallback is correct and undiagnosable: everything works,
      // just slower, so a broken platform package stays broken until somebody thinks to look.
      assert.includes(result.stderr, 'could not be started');
      assert.includes(result.stderr, PLATFORM_PACKAGE, 'naming the package to report');
    });
  }
});

module('Bin | the host Node it builds on', { concurrency: true }, () => {
  test('the archive is named the way nodejs.org names it', (assert) => {
    assert.strictEqual(
      archiveNameFor('v24.19.0', 'linux', 'x64'),
      'node-v24.19.0-linux-x64.tar.gz',
    );
    assert.strictEqual(
      archiveNameFor('v24.19.0', 'darwin', 'arm64'),
      'node-v24.19.0-darwin-arm64.tar.gz',
    );
    // Windows is `win`, not `win32`, and a zip rather than a tarball.
    assert.strictEqual(archiveNameFor('v24.19.0', 'win32', 'x64'), 'node-v24.19.0-win-x64.zip');
  });

  test('a musl host is the same name with -musl on the end', (assert) => {
    assert.strictEqual(
      archiveNameFor('v24.19.0', 'linux', 'arm64', 'musl'),
      'node-v24.19.0-linux-arm64-musl.tar.gz',
    );
  });

  test('the URL is the official dist path', (assert) => {
    assert.strictEqual(
      archiveUrlFor('v24.19.0', 'node-v24.19.0-linux-x64.tar.gz'),
      'https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.gz',
    );
  });

  test('a musl host comes from unofficial-builds, which nodejs.org does not carry', (assert) => {
    assert.strictEqual(
      archiveUrlFor('v24.19.0', 'node-v24.19.0-linux-x64-musl.tar.gz', 'musl'),
      'https://unofficial-builds.nodejs.org/download/release/v24.19.0/node-v24.19.0-linux-x64-musl.tar.gz',
    );
  });

  test('the checksum is read out of the manifest by name', (assert) => {
    const manifest = [
      'aaa11  node-v1-darwin-arm64.tar.gz',
      'bbb22  node-v1-linux-x64.tar.gz',
      'ccc33  node-v1-linux-x64.tar.xz',
      '',
    ].join('\n');

    assert.strictEqual(shaFor(manifest, 'node-v1-linux-x64.tar.gz'), 'bbb22');
    assert.strictEqual(shaFor(manifest, 'node-v1-darwin-arm64.tar.gz'), 'aaa11');
    // A target the manifest does not mention must not resolve to something else's checksum.
    assert.strictEqual(shaFor(manifest, 'node-v1-win-x64.zip'), null);
  });

  test('Windows unpacks with its own bsdtar, not whichever tar PATH finds first', (assert) => {
    // In Git Bash, PATH's tar is GNU tar: it read `C:\\…\\node-…-win-x64.zip` as a remote host `C`
    // and failed the Windows SEA build with "Cannot connect to C: resolve failed".
    assert.strictEqual(
      tarFor('win32', { SystemRoot: 'C:\\Windows' }),
      'C:\\Windows\\System32\\tar.exe',
    );
    assert.strictEqual(tarFor('win32', {}), 'C:\\Windows\\System32\\tar.exe', 'the default root');
    assert.strictEqual(tarFor('linux', { SystemRoot: 'ignored' }), 'tar');
    assert.strictEqual(tarFor('darwin', {}), 'tar');
  });

  test('the path it prints runs in Git Bash, which only treats `/` as a path', (assert) => {
    // A word with no `/` in it is looked up on PATH, so Windows' own `\\` path would be
    // "command not found" (exit 127) in `"$(node scripts/fetch-node-binary.ts)" …`.
    assert.strictEqual(
      forShells('D:\\a\\qunitx-cli\\node_modules\\.cache\\node.exe', '\\'),
      'D:/a/qunitx-cli/node_modules/.cache/node.exe',
    );
    assert.strictEqual(forShells('/home/me/repo/node', '/'), '/home/me/repo/node', 'POSIX as is');
  });

  test('the executable sits where the archive puts it', (assert) => {
    assert.strictEqual(
      binaryInsideArchive('node-v1-linux-x64', 'linux'),
      'node-v1-linux-x64/bin/node',
    );
    assert.strictEqual(binaryInsideArchive('node-v1-win-x64', 'win32'), 'node-v1-win-x64/node.exe');
  });
});

/**
 * Installs a `qunitx-cli-linux-x64` whose binary is present, executable, the right version — and
 * cannot be exec'd, because its ELF interpreter does not exist.
 *
 * The real thing that shipped, in 148 bytes. Removed at the end of the scope, and only ever
 * written where no such package is installed, so a real one is never overwritten.
 */
async function plantBrokenPlatformPackage() {
  const version = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'),
  ).version;
  const directory = path.join(repoRoot, 'node_modules', PLATFORM_PACKAGE);
  if (await exists(directory)) {
    throw new Error(`${directory} already exists — refusing to write over a real package`);
  }
  await fs.mkdir(path.join(directory, 'bin'), { recursive: true });
  await fs.writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: PLATFORM_PACKAGE, version }),
  );
  const binary = path.join(directory, 'bin', 'qunitx');
  await fs.writeFile(binary, elfNaming('/nonexistent/ld-linux-x86-64.so.2'));
  await fs.chmod(binary, 0o755);

  return {
    kind: 'broken-elf' as const,
    version,
    async [Symbol.asyncDispose]() {
      // `rmRetry`, not a bare recursive `fs.rm`: this test spawned a process against the
      // directory, and Windows answers EBUSY for a moment after one exits.
      await rmRetry(directory);
    },
  };
}

/**
 * Builds `dist/cli.js` if it is not there.
 *
 * `dist/` is gitignored and nothing in the test flow builds it, so on a fresh checkout — which is
 * every CI run — the launcher's fallback target does not exist and the import at the end of it
 * throws. Without this the test failed in CI for that reason rather than the one it is about,
 * which is exactly the kind of red that teaches people to ignore red. Half a second, once.
 */
async function ensureBundledCli(): Promise<void> {
  if (await exists(path.join(repoRoot, 'dist', 'cli.js'))) return;

  await promisify(execFile)('node', ['scripts/build-cli.js'], { cwd: repoRoot });
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);

    return true;
  } catch {
    return false;
  }
}
