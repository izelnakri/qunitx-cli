import { module, test } from 'qunitx';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import '../helpers/custom-asserts.ts';

// Guards the Windows regression where scripts/test-release.sh sets QUNITX_BIN to
// node_modules/.bin/qunitx and shell.ts calls spawn(QUNITX_BIN, args). On Windows,
// spawn() cannot execute shell wrapper scripts in .bin/ — it needs an actual binary
// or a node invocation. The fix: on Windows QUNITX_BIN points to bin/qunitx.js and
// shell.ts detects the .js extension, invoking spawn(process.execPath, [QUNITX_BIN, ...args]).
// This test verifies that exact pattern works cross-platform.
module('Commands | QUNITX_BIN JS invocation', () => {
  test('bin/qunitx.js can be invoked via spawn(process.execPath, [jsFile, --version])', async (assert) => {
    const jsFile = resolve('bin/qunitx.js');
    const { code, stdout } = await new Promise<{ code: number; stdout: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [jsFile, '--version']);
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr.resume();
        child.once('exit', (c) => resolve({ code: c ?? 1, stdout: out }));
        child.once('error', reject);
      },
    );

    assert.equal(code, 0, 'exits 0');
    assert.regex(stdout.trim(), /^\d+\.\d+\.\d+$/, 'prints a bare semver string');
  });
});
