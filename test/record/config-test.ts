import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as Config from '../../lib/record/config.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import '../helpers/custom-asserts.ts';

// A project whose package.json has `record` as its `qunitx.record`, and a folder inside it.
async function project(name: string, record: unknown) {
  const dir = await tempDir(name);
  await fs.writeFile(
    path.join(dir.path, 'package.json'),
    JSON.stringify(record === undefined ? { name: 'app' } : { name: 'app', qunitx: { record } }),
  );
  await fs.mkdir(path.join(dir.path, 'nested', 'deeper'), { recursive: true });
  return dir;
}

const messageOf = async (record: unknown) => {
  await using dir = await project('record-config-refused', record);
  const read = await Config.read(dir.path);
  return Config.InvalidRecordConfig.is(read) ? read.message : 'accepted';
};

module('Record | package.json config', { concurrency: true }, () => {
  test('each setting is the option of its name; inputs and output are from the package.json', async (assert) => {
    await using dir = await project('record-config', {
      inputs: ['http://localhost:4200/', 'pages/home.html'],
      formats: ['png', 'tour.gif'],
      width: 1280,
      fullPage: true,
      mask: ['#clock', '.avatar'],
      output: 'snapshots',
      report: ['html', 'pdf'],
      prComment: true,
      imagesUrl: 'https://ci.test/shots/',
      pdf: { paper: 'A4' },
    });

    // Read from a folder deep inside: paths still start at the package.json.
    assert.deepEqual(await Config.read(path.join(dir.path, 'nested', 'deeper')), {
      inputs: ['http://localhost:4200/', path.join(dir.path, 'pages', 'home.html')],
      options: {
        formats: ['png', 'tour.gif'],
        width: 1280,
        fullPage: true,
        mask: ['#clock', '.avatar'],
        output: path.join(dir.path, 'snapshots'),
        report: ['html', 'pdf'],
        prComment: true,
        imagesUrl: 'https://ci.test/shots/',
        pdf: { paper: 'A4' },
      },
    });
  });

  test('no qunitx.record, or no package.json at all, configures nothing', async (assert) => {
    await using dir = await project('record-config-none', undefined);
    await using bare = await tempDir('record-config-bare');

    assert.deepEqual(await Config.read(dir.path), { inputs: [], options: {} });
    assert.deepEqual(await Config.read(bare.path), { inputs: [], options: {} });
  });

  test('a setting is refused by name: unknown ones, update and cwd, and values the rules turn down', async (assert) => {
    const unknown = 'is not a setting qunitx record understands (see qunitx record --help)';

    assert.deepEqual(
      await Promise.all([
        messageOf({ update: true }),
        messageOf({ cwd: '/elsewhere' }),
        messageOf({ colour: 'red' }),
        messageOf({ width: 'wide' }),
        messageOf({ pdf: { paper: 'A9000' } }),
        messageOf({ inputs: 'home.html' }),
        messageOf(['home.html']),
      ]),
      [
        `package.json#qunitx.record.update: ${unknown}`,
        `package.json#qunitx.record.cwd: ${unknown}`,
        `package.json#qunitx.record.colour: ${unknown}`,
        'package.json#qunitx.record.width: expected a whole number of pixels from 1 to 16384, got "wide"',
        'package.json#qunitx.record.pdf: paper: expected one of fit, Letter, Legal, Tabloid, Ledger, A0, A1, A2, A3, A4, A5, A6, got "A9000"',
        'package.json#qunitx.record.inputs: must be a list of strings',
        'package.json#qunitx.record: must be an object',
      ],
    );
  });
});
