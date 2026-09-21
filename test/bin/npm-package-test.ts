import { module, test } from 'qunitx';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { tempDir } from '../helpers/temp-dir.ts';

const execFileAsync = promisify(execFile);

// `dist/` is shared: `npm run build` writes the CLI and the API there, and `make build-deno`
// writes the 460MB deno binary and its esbuild sidecar beside them. With `files` naming the whole
// directory, a release made after a local deno build would have published a 164MB tarball.
module('Bin | the npm package', () => {
  test('ships what `npm run build` makes, and not binaries built next to it', async (assert) => {
    await using dir = await tempDir('npm-package');
    await fs.copyFile('package.json', path.join(dir.path, 'package.json'));
    await fs.mkdir(path.join(dir.path, 'dist', 'types'), { recursive: true });
    for (const file of ['cli.js', 'index.js', 'types/index.d.ts', 'qunitx', 'esbuild']) {
      await fs.writeFile(path.join(dir.path, 'dist', file), '');
    }

    const { stdout } = await execFileAsync('npm', ['pack', '--dry-run', '--json'], {
      cwd: dir.path,
      shell: process.platform === 'win32',
    });
    const packed = JSON.parse(stdout)[0].files.map((file: { path: string }) => file.path);

    assert.deepEqual(
      packed.filter((file: string) => file.startsWith('dist/')).sort(),
      ['dist/cli.js', 'dist/index.js', 'dist/types/index.d.ts'],
      'dist/qunitx and dist/esbuild stay out',
    );
  });
});
