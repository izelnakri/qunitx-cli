import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as Manifest from '../../../lib/commands/upgrade/manifest.ts';
import { Failure } from '../../../lib/result/index.ts';
import { tempDir } from '../../helpers/temp-dir.ts';
import '../../helpers/custom-asserts.ts';

// The one thing `--write-manifest` does: move a declared range, in whichever manifest the project
// keeps it in, and touch nothing else. Real files in a temp directory — there is no seam to fake
// here, and the formatting it must preserve only exists in a real file.

const write = (dir: string, name: string, content: string) =>
  fs.writeFile(path.join(dir, name), content);
const read = (dir: string, name: string) => fs.readFile(path.join(dir, name), 'utf8');

module('Commands | Upgrade | Manifest.bump | package.json', { concurrency: true }, () => {
  test('keeps the range operator the project chose', async (assert) => {
    await using dir = await tempDir('manifest-ranges');

    for (const [previous, expected] of [
      ['^0.34.5', '^0.35.0'],
      ['~0.34.5', '~0.35.0'],
      ['0.34.5', '0.35.0'],
    ]) {
      await write(
        dir.path,
        'package.json',
        JSON.stringify({ devDependencies: { 'qunitx-cli': previous } }),
      );

      const bumped = await Manifest.bump(path.join(dir.path, 'package.json'), '0.35.0');

      assert.deepEqual(bumped, { field: 'devDependencies', range: expected });
      assert.strictEqual(
        JSON.parse(await read(dir.path, 'package.json')).devDependencies['qunitx-cli'],
        expected,
        `${previous} → ${expected}: an exact pin is a decision, not an accident`,
      );
    }
  });

  test('edits the block the dependency is actually declared in', async (assert) => {
    await using dir = await tempDir('manifest-deps-block');
    await write(
      dir.path,
      'package.json',
      JSON.stringify({
        dependencies: { 'qunitx-cli': '^0.34.5' },
        devDependencies: { other: '1' },
      }),
    );

    const bumped = await Manifest.bump(path.join(dir.path, 'package.json'), '0.35.0');
    const manifest = JSON.parse(await read(dir.path, 'package.json'));

    assert.strictEqual(bumped.field, 'dependencies');
    assert.strictEqual(manifest.dependencies['qunitx-cli'], '^0.35.0');
    assert.deepEqual(manifest.devDependencies, { other: '1' }, 'nothing else is rewritten');
  });

  test('a package.json that does not declare qunitx-cli is a failure, not a new entry', async (assert) => {
    await using dir = await tempDir('manifest-absent');
    await write(dir.path, 'package.json', JSON.stringify({ devDependencies: { other: '1' } }));

    const failure = await Manifest.bump(path.join(dir.path, 'package.json'), '0.35.0').catch(
      (error: unknown) => error,
    );

    assert.ok(Failure.is(failure) && failure.code === 'UpgradeManifestEntryMissing');
    assert.deepEqual(JSON.parse(await read(dir.path, 'package.json')), {
      devDependencies: { other: '1' },
    });
  });
});

module('Commands | Upgrade | Manifest.bump | deno.json', { concurrency: true }, () => {
  test('moves the version inside the import specifier, keeping its operator', async (assert) => {
    await using dir = await tempDir('manifest-deno');

    for (const [previous, expected] of [
      ['npm:qunitx-cli@^0.34.5', 'npm:qunitx-cli@^0.35.0'],
      ['npm:qunitx-cli@~0.34.5', 'npm:qunitx-cli@~0.35.0'],
      ['npm:qunitx-cli@0.34.5', 'npm:qunitx-cli@0.35.0'],
      ['jsr:@izelnakri/qunitx-cli@^0.34.5', 'jsr:@izelnakri/qunitx-cli@^0.35.0'],
    ]) {
      await write(
        dir.path,
        'deno.json',
        JSON.stringify({ imports: { 'qunitx-cli': previous } }, null, 2),
      );

      const bumped = await Manifest.bump(path.join(dir.path, 'deno.json'), '0.35.0');
      const manifest = JSON.parse(await read(dir.path, 'deno.json'));

      assert.strictEqual(bumped.field, 'imports');
      assert.strictEqual(manifest.imports['qunitx-cli'], expected);
    }
  });

  test('a .jsonc keeps its comments — the whole reason this is a text edit', async (assert) => {
    // JSON.parse + JSON.stringify would round-trip this file into a comment-free reformat, and
    // silently deleting a user's notes is not an acceptable side effect of a version bump.
    await using dir = await tempDir('manifest-jsonc');
    const original = [
      '{',
      '  // Pinned deliberately: 0.35 drops node 22 support.',
      '  "imports": {',
      '    "qunitx-cli": "npm:qunitx-cli@^0.34.5", // keep the caret',
      '    "other": "npm:other@1.0.0"',
      '  },',
      '  "tasks": { "test": "qunitx test/" }',
      '}',
      '',
    ].join('\n');
    await write(dir.path, 'deno.jsonc', original);

    const bumped = await Manifest.bump(path.join(dir.path, 'deno.jsonc'), '0.35.0');
    const after = await read(dir.path, 'deno.jsonc');

    assert.deepEqual(bumped, { field: 'imports', range: '^0.35.0' });
    assert.strictEqual(after, original.replace('^0.34.5', '^0.35.0'));
    assert.includes(after, '// Pinned deliberately: 0.35 drops node 22 support.');
    assert.includes(after, '// keep the caret');
    assert.includes(after, '"other": "npm:other@1.0.0"', 'the neighbouring entry is untouched');
  });

  test('an unpinned or absent import is refused rather than guessed at', async (assert) => {
    await using dir = await tempDir('manifest-unpinned');
    await write(
      dir.path,
      'deno.json',
      JSON.stringify({ imports: { 'qunitx-cli': 'npm:qunitx-cli' } }),
    );

    const failure = await Manifest.bump(path.join(dir.path, 'deno.json'), '0.35.0').catch(
      (error: unknown) => error,
    );

    assert.ok(Failure.is(failure) && failure.code === 'UpgradeManifestEntryMissing');
    assert.includes(Failure.format(failure), 'deno.json');
  });
});

module('Commands | Upgrade | Manifest.registry', { concurrency: true }, () => {
  test('answers with the registry the entry is actually pinned through', async (assert) => {
    await using dir = await tempDir('manifest-registry');

    await write(
      dir.path,
      'deno.json',
      JSON.stringify({ imports: { x: 'npm:qunitx-cli@^0.34.5' } }),
    );
    assert.strictEqual(await Manifest.registry(path.join(dir.path, 'deno.json')), 'npm');

    await write(
      dir.path,
      'deno.json',
      JSON.stringify({ imports: { x: 'jsr:@izelnakri/qunitx-cli@^0.34.5' } }),
    );
    assert.strictEqual(await Manifest.registry(path.join(dir.path, 'deno.json')), 'jsr');

    assert.strictEqual(
      await Manifest.registry(path.join(dir.path, 'nothing-here.json')),
      'npm',
      'an unreadable manifest falls back to npm rather than throwing mid-refusal',
    );
  });
});
