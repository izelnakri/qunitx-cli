import { module, test } from 'qunitx';
import { tempDir } from '../helpers/temp-dir.ts';
import { spawnCapture } from '../helpers/shell.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import '../helpers/custom-asserts.ts';

// `deno publish` resolves every npm dependency it can see in the staged tree, and v0.34.5's
// release died resolving `qunitx@^1.3.1` — a devDependency the published package never imports,
// whose only satisfying version was younger than deno's 24h minimum-dependency-age. npm and the
// GitHub release had already gone out, so the version existed everywhere except JSR.
//
// Staging into a temp directory rather than the real jsr/, so this cannot race a release that is
// staging it for real.
module('Bin | stage-jsr-library', { concurrency: true }, () => {
  async function stagedManifest(label: string) {
    await using target = await tempDir(label);
    await spawnCapture(`node scripts/stage-jsr-library.ts ${target.path}`, {
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    return JSON.parse(await fs.readFile(path.join(target.path, 'package.json'), 'utf8'));
  }

  test('the staged manifest carries no devDependencies', async (assert) => {
    const manifest = await stagedManifest('stage-jsr-devdeps');

    assert.false(
      'devDependencies' in manifest,
      'a devDependency published in the last 24h would otherwise block the JSR release',
    );
    assert.false('scripts' in manifest, 'and scripts name files that are not in the package');
  });

  test('it keeps the version the published code reads back', async (assert) => {
    // lib/commands/help.ts and lib/commands/daemon/index.ts both import this manifest for
    // `pkg.version` — pruning that away would print `qunitx vundefined` to every JSR user.
    const [manifest, own] = await Promise.all([
      stagedManifest('stage-jsr-version'),
      fs.readFile('package.json', 'utf8').then(JSON.parse),
    ]);

    assert.equal(manifest.version, own.version);
    assert.equal(manifest.name, own.name);
    assert.deepEqual(manifest.dependencies, own.dependencies, 'runtime deps are still declared');
  });

  test('it stages what the ./api export needs at runtime', async (assert) => {
    await using target = await tempDir('stage-jsr-tree');
    await spawnCapture(`node scripts/stage-jsr-library.ts ${target.path}`, {
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    // readTemplate resolves `../../templates` from lib/utils/, so the mirrored layout is
    // load-bearing rather than incidental.
    const staged = async (relativePath: string) =>
      (await fs.stat(path.join(target.path, relativePath)).catch(() => null))?.isFile() ?? false;

    assert.true(await staged('lib/api/index.ts'), 'the ./api entrypoint');
    assert.true(await staged('templates/vendor/qunit.css'), 'and the templates read at runtime');
  });
});
