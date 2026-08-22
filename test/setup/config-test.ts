import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as Config from '../../lib/setup/config.ts';
import * as Options from '../../lib/api/options.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import '../helpers/custom-asserts.ts';

// No browser and no bundle: these assemble a config over a throwaway project and read it back.

/** A project whose package.json already answers the questions the options below leave open. */
async function project() {
  const dir = await tempDir('setup-config');
  await fs.writeFile(
    path.join(dir.path, 'package.json'),
    JSON.stringify({
      name: 'config-fixture',
      type: 'module',
      qunitx: { browser: 'firefox', extensions: ['ts'], port: 4321 },
    }),
  );
  await fs.mkdir(path.join(dir.path, 'test'), { recursive: true });
  await fs.writeFile(path.join(dir.path, 'test', 'a-test.ts'), 'export {};\n');

  return dir;
}

module('Setup | config | options merge over package.json', { concurrency: true }, () => {
  test('an option the caller never named leaves the project config alone', async (assert) => {
    await using dir = await project();

    // Every key is present and undefined — exactly the shape an options object built from
    // partially-filled fields has, and the one that used to overwrite package.json with nothing.
    const config = await Config.setup({
      cwd: dir.path,
      inputs: ['test/'],
      browser: undefined,
      extensions: undefined,
      port: undefined,
    });

    assert.equal(config.browser, 'firefox', 'browser survived');
    assert.deepEqual(config.extensions, ['ts'], 'extensions survived');
    assert.equal(config.port, 4321, 'port survived');
  });

  test('an option the caller did name wins', async (assert) => {
    await using dir = await project();

    const config = await Config.setup({
      cwd: dir.path,
      inputs: ['test/'],
      browser: 'webkit',
      extensions: undefined,
    });

    assert.equal(config.browser, 'webkit', 'the option beats package.json');
    assert.deepEqual(
      config.extensions,
      ['ts'],
      'the one left unnamed still comes from the project',
    );
  });
});

module('Setup | config | reporters given are live during assembly', { concurrency: true }, () => {
  test('a reporter pushed on before setup sees the notices setup itself emits', async (assert) => {
    await using dir = await project();
    const seen: string[] = [];

    // What `openSession` relies on: `Options.from` hands back a pushable `reporters`, and a
    // reporter added before `Config.setup` catches the diagnostics setup emits while resolving —
    // here, `--only-failed` finding no cache. A feed attached after setup returns misses them.
    const configOptions = Options.from({
      cwd: dir.path,
      inputs: ['test/'],
      onlyFailed: true,
    });
    configOptions.reporters.push({ onNotice: (_config, notice) => void seen.push(notice.message) });
    await Config.setup(configOptions);

    assert.true(
      seen.some((message) => message.includes('--only-failed')),
      `the setup-time notice reached it, got ${JSON.stringify(seen)}`,
    );
  });
});
