import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as QUnitX from '../../lib/api/index.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import '../helpers/custom-asserts.ts';

// No browser: these write files and report what they wrote.

/** A throwaway project directory with just enough package.json to be a project root. */
async function project() {
  const dir = await tempDir('api-scaffold');
  await fs.writeFile(
    path.join(dir.path, 'package.json'),
    JSON.stringify({ name: 'scaffold-fixture', type: 'module' }),
  );

  return dir;
}

module('API | init', { concurrency: true }, () => {
  test('reports the files it created', async (assert) => {
    await using dir = await project();

    const result = await QUnitX.init({ cwd: dir.path });

    assert.deepEqual(result.skipped, []);
    assert.true(
      result.written.some((file) => file.endsWith('tests.html')),
      'the HTML fixture',
    );
    assert.true(
      result.written.some((file) => file.endsWith('tsconfig.json')),
      'and a tsconfig, since there was none',
    );
  });

  test('writes the qunitx block into package.json', async (assert) => {
    await using dir = await project();

    await QUnitX.init({ cwd: dir.path });
    const packageJSON = JSON.parse(
      await fs.readFile(path.join(dir.path, 'package.json'), 'utf8'),
    ) as { qunitx?: { htmlPaths?: string[] } };

    assert.deepEqual(packageJSON.qunitx?.htmlPaths, ['test/tests.html']);
  });

  test('never overwrites — a second call reports skips instead', async (assert) => {
    await using dir = await project();

    await QUnitX.init({ cwd: dir.path });
    const again = await QUnitX.init({ cwd: dir.path });

    assert.deepEqual(again.written, [], 'nothing was rewritten');
    assert.deepEqual(again.skipped, ['test/tests.html']);
  });

  test('honours the html paths it is given', async (assert) => {
    await using dir = await project();

    const result = await QUnitX.init({ cwd: dir.path, htmlPaths: ['test/custom.html'] });

    assert.true(result.written.some((file) => file.endsWith('test/custom.html')));
  });

  test('a directory with no package.json above it is a named failure', async (assert) => {
    await using dir = await tempDir('api-scaffold-bare');
    // os.tmpdir() has no package.json above it on any supported platform, so the walk bottoms out.
    const outcome = await QUnitX.init({ cwd: dir.path }).result();

    assert.equal(
      QUnitX.Failure.is(outcome) ? outcome.code : 'not-a-failure',
      'ProjectRootNotFound',
    );
  });
});

module('API | generate', { concurrency: true }, () => {
  test('writes the file and says where', async (assert) => {
    await using dir = await project();

    const result = await QUnitX.generate({ cwd: dir.path, target: 'test/login-test.ts' });

    assert.true(result.created);
    assert.true(result.path.endsWith('test/login-test.ts'));
    assert.includes(await fs.readFile(result.path, 'utf8'), "module('");
  });

  test('derives the module name from the path, minus the test/ segment', async (assert) => {
    await using dir = await project();

    const { path: written } = await QUnitX.generate({
      cwd: dir.path,
      target: 'test/users/contact-details-test.ts',
    });

    assert.includes(await fs.readFile(written, 'utf8'), "module('Users | ContactDetails");
  });

  test('appends .js when the target has no extension', async (assert) => {
    await using dir = await project();

    const result = await QUnitX.generate({ cwd: dir.path, target: 'test/login-test' });

    assert.true(result.path.endsWith('test/login-test.js'));
  });

  test('never overwrites — an existing file is reported, not replaced', async (assert) => {
    await using dir = await project();
    const target = 'test/login-test.ts';

    const first = await QUnitX.generate({ cwd: dir.path, target });
    await fs.writeFile(first.path, '// mine\n');
    const second = await QUnitX.generate({ cwd: dir.path, target });

    assert.false(second.created);
    assert.equal(await fs.readFile(second.path, 'utf8'), '// mine\n', 'left exactly as it was');
  });
});
