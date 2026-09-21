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

// `install.sh` ships a glibc binary. On Alpine it used to print "installed" and hand over a file
// whose loader does not exist there — `No such file or directory`, the same silence as the NixOS
// bug — and gcompat does not rescue it (`__res_init: symbol not found`). These drive the real
// script with a stand-in `ldd`, so musl is simulated without a container or a download.
module('Bin | install.sh on musl', { concurrency: true }, () => {
  if (process.platform !== 'linux') {
    test('skipped: the libc check only runs on Linux', (assert) => {
      assert.ok(true);
    });
  }

  if (process.platform === 'linux') {
    test('a musl system is refused before anything is downloaded', async (assert) => {
      await using sandbox = await tempDir('install-musl');
      const result = await installer(sandbox.path, 'musl libc (x86_64)\nVersion 1.2.5');

      assert.notStrictEqual(result.code, 0, 'it does not claim to have installed anything');
      assert.includes(result.stderr, 'musl libc');
      assert.includes(result.stderr, 'npm install --save-dev qunitx-cli', 'and says what works');
      assert.notIncludes(result.stdout + result.stderr, 'fetching', 'nothing was downloaded');
      assert.false(await exists(path.join(sandbox.path, 'bin', 'qunitx')));
    });

    test('a glibc system goes straight past the check', async (assert) => {
      await using sandbox = await tempDir('install-glibc');
      const result = await installer(sandbox.path, 'ldd (GNU libc) 2.40');

      assert.notIncludes(result.stderr, 'musl', 'no refusal');
      // The stand-in curl fails on purpose, so reaching it is the proof the check let this through.
      assert.includes(result.stdout, 'fetching');
    });
  }
});

/**
 * Runs the real installer with `ldd` answering as `lddSays`, a curl that fails at once, and every
 * path it could write confined to the sandbox.
 */
async function installer(
  sandbox: string,
  lddSays: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const shims = path.join(sandbox, 'shims');
  await fs.mkdir(shims, { recursive: true });
  await fs.writeFile(path.join(shims, 'ldd'), `#!/bin/sh\nprintf '%s\\n' '${lddSays}' >&2\n`);
  await fs.writeFile(path.join(shims, 'curl'), '#!/bin/sh\nexit 22\n');
  await fs.chmod(path.join(shims, 'ldd'), 0o755);
  await fs.chmod(path.join(shims, 'curl'), 0o755);

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

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);

    return true;
  } catch {
    return false;
  }
}
