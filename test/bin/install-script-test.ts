import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { module, test } from 'qunitx';
import { tempDir } from '../helpers/temp-dir.ts';
import '../helpers/custom-asserts.ts';

const run = promisify(execFile);
const INSTALLER = path.join(process.cwd(), 'install.sh');

// `install.sh` used to ship only a glibc binary, and on Alpine it printed "installed" and handed
// over a file whose loader does not exist there. These drive the real script with a stand-in
// `ldd` and a stand-in `curl` that serves a release built in the sandbox, so musl and the whole
// install are exercised without a container or a network.
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';

module('Bin | install.sh | which build it installs', { concurrency: true }, () => {
  if (process.platform !== 'linux') {
    test('skipped: the libc choice only happens on Linux', (assert) => {
      assert.ok(true);
    });
  }

  if (process.platform === 'linux') {
    test('a musl system gets the musl build, in its own directory', async (assert) => {
      await using sandbox = await tempDir('install-musl');
      const result = await installer(sandbox.path, 'musl libc (x86_64)\nVersion 1.2.5');

      assert.strictEqual(result.code, 0, result.stderr);
      assert.includes(result.stdout, `qunitx-linux-${ARCH}-musl.tar.gz`);
      const bin = path.join(sandbox.path, 'bin');
      assert.strictEqual(await fs.readlink(path.join(bin, 'qunitx')), 'qunitx-musl/qunitx');
      assert.true(await exists(path.join(bin, 'qunitx-musl', 'lib', 'libstdc++.so.6')));
      assert.true(await exists(path.join(bin, 'qunitx-musl', 'node_modules', 'playwright-core')));
      assert.false(await exists(path.join(bin, 'lib')), 'nothing loose beside other binaries');
    });

    test('a glibc system gets the deno build', async (assert) => {
      await using sandbox = await tempDir('install-glibc');
      const result = await installer(sandbox.path, 'ldd (GNU libc) 2.40');

      assert.strictEqual(result.code, 0, result.stderr);
      assert.includes(result.stdout, `qunitx-deno-linux-${ARCH}.tar.gz`);
      assert.strictEqual(
        await fs.readFile(path.join(sandbox.path, 'bin', 'qunitx'), 'utf8'),
        'deno',
      );
    });

    test('the deno build over a musl install replaces the link, not what it points at', async (assert) => {
      await using sandbox = await tempDir('install-switch');
      await installer(sandbox.path, 'musl libc (x86_64)');
      await installer(sandbox.path, 'ldd (GNU libc) 2.40');

      const bin = path.join(sandbox.path, 'bin');
      assert.false((await fs.lstat(path.join(bin, 'qunitx'))).isSymbolicLink());
      assert.strictEqual(
        await fs.readFile(path.join(bin, 'qunitx-musl', 'qunitx'), 'utf8'),
        'musl',
        'cp did not write through the old link',
      );
    });
  }
});

/**
 * Runs the real installer with `ldd` answering as `lddSays` and a `curl` that serves the one
 * release asset the script asks for from the sandbox. Every path it could write is inside it.
 */
async function installer(
  sandbox: string,
  lddSays: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const shims = path.join(sandbox, 'shims');
  const release = path.join(sandbox, 'release');
  // Only `-o <file> <url>` downloads are served; anything else (the latest-release lookup) fails,
  // since every run here pins VERSION.
  const scripts = {
    ldd: `#!/bin/sh\nprintf '%s\\n' '${lddSays}' >&2\n`,
    curl:
      `#!/bin/sh\nfor a; do case "$a" in https://*) url="$a";; esac; done\n` +
      `prev=""; for a; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done\n` +
      `[ -n "\${out:-}" ] || exit 22\ncp "${release}/\${url##*/}" "$out" || exit 22\n`,
  };
  await Promise.all([
    buildRelease(release),
    fs.mkdir(shims, { recursive: true }).then(() =>
      Promise.all(
        Object.entries(scripts).map(async ([name, script]) => {
          await fs.writeFile(path.join(shims, name), script);
          await fs.chmod(path.join(shims, name), 0o755);
        }),
      ),
    ),
  ]);

  try {
    const done = await run('sh', [INSTALLER], {
      env: {
        ...process.env,
        PATH: `${shims}${path.delimiter}${process.env.PATH ?? ''}`,
        HOME: sandbox,
        INSTALL_DIR: path.join(sandbox, 'bin'),
        VERSION: 'v0.0.0',
      },
    });

    return { code: 0, stdout: done.stdout, stderr: done.stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };

    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

/** Both Linux assets for this arch, laid out as the release workflow packs them. */
async function buildRelease(release: string): Promise<void> {
  const deno = path.join(release, 'src', `qunitx-deno-linux-${ARCH}`);
  const musl = path.join(release, 'src', `qunitx-linux-${ARCH}-musl`);
  await Promise.all(
    [deno, path.join(musl, 'lib'), path.join(musl, 'node_modules', 'playwright-core')].map((dir) =>
      fs.mkdir(dir, { recursive: true }),
    ),
  );
  await Promise.all(
    Object.entries({
      [path.join(deno, 'qunitx')]: 'deno',
      [path.join(deno, 'esbuild')]: '',
      [path.join(musl, 'qunitx')]: 'musl',
      [path.join(musl, 'esbuild')]: '',
      [path.join(musl, 'lib', 'libstdc++.so.6')]: '',
    }).map(([file, content]) => fs.writeFile(file, content)),
  );
  // Each archive reads only its own directory, so the two are packed side by side.
  await Promise.all(
    [deno, musl].map((dir) => {
      const name = path.basename(dir);
      return run('tar', [
        'czf',
        path.join(release, `${name}.tar.gz`),
        '-C',
        path.dirname(dir),
        name,
      ]);
    }),
  );
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);

    return true;
  } catch {
    return false;
  }
}
