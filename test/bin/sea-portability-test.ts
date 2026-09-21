import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { module, test } from 'qunitx';
import {
  checkPortability,
  interpreterOf,
  isPortableInterpreter,
} from '../../scripts/check-sea-portability.ts';
import { elfNaming } from '../helpers/tiny-elf.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import '../helpers/custom-asserts.ts';

// The release gate for one bug that shipped for months: a SEA built by copying `process.execPath`
// on NixOS names an ELF interpreter inside /nix/store, so `execve` fails on every other
// distribution — 127 from a shell, no output, nothing to search for. Everything below is about
// catching that before `npm publish` rather than after.

module('Bin | SEA portability | which interpreters travel', { concurrency: true }, () => {
  test('the standard loaders are portable', (assert) => {
    assert.true(isPortableInterpreter('/lib64/ld-linux-x86-64.so.2'), 'glibc x64');
    assert.true(isPortableInterpreter('/lib/ld-linux-aarch64.so.1'), 'glibc arm64');
    assert.true(isPortableInterpreter('/lib/ld-musl-x86-64.so.1'), 'musl x64');
  });

  test('a store path is not, which is the whole point', (assert) => {
    assert.false(
      isPortableInterpreter(
        '/nix/store/m07h00fl6538s4gavrp66a20ka4hg7fy-glibc-2.42-67/lib/ld-linux-x86-64.so.2',
      ),
      'the exact interpreter qunitx-cli-linux-x64@0.36.0 shipped with',
    );
    assert.false(isPortableInterpreter('/home/me/.local/lib/ld-linux-x86-64.so.2'));
    assert.false(isPortableInterpreter('/opt/toolchain/lib/ld.so'));
  });

  test('no interpreter at all is portable — static, or not an ELF', (assert) => {
    assert.true(isPortableInterpreter(null));
  });
});

module('Bin | SEA portability | reading a real file', { concurrency: true }, () => {
  test('the interpreter is read out of PT_INTERP', async (assert) => {
    await using directory = await tempDir('sea-interp');
    const file = path.join(directory.path, 'crafted');
    await fs.writeFile(file, elfNaming('/lib64/ld-linux-x86-64.so.2'));

    assert.strictEqual(await interpreterOf(file), '/lib64/ld-linux-x86-64.so.2');
  });

  test('this machine’s own Node names an absolute loader', async (assert) => {
    // A real binary, present wherever this suite runs: NixOS answers with a /nix/store path and
    // a distro with /lib64, and either way it is an absolute path to something called ld.
    const interpreter = await interpreterOf(process.execPath);
    if (process.platform !== 'linux') {
      assert.strictEqual(interpreter, null, 'a Mach-O or PE names no ELF interpreter');

      return;
    }
    assert.true((interpreter ?? '').startsWith('/'), `absolute, got ${interpreter}`);
    assert.includes(interpreter ?? '', 'ld-');
  });

  test('a file that is not an ELF has no interpreter and is not a failure', async (assert) => {
    await using directory = await tempDir('sea-not-elf');
    const file = path.join(directory.path, 'notelf');
    await fs.writeFile(file, '#!/bin/sh\necho hi\n');

    assert.strictEqual(await interpreterOf(file), null);
    assert.true((await checkPortability(file)).portable, 'nothing to object to');
  });
});

module('Bin | SEA portability | the verdict', { concurrency: true }, () => {
  test('a store interpreter is refused, and says why it matters', async (assert) => {
    await using directory = await tempDir('sea-verdict-bad');
    const file = path.join(directory.path, 'nixed');
    await fs.writeFile(file, elfNaming('/nix/store/abc-glibc/lib/ld-linux-x86-64.so.2'));
    const verdict = await checkPortability(file);

    assert.false(verdict.portable);
    assert.strictEqual(verdict.problems.length, 2, 'the interpreter, and the store path in it');
    assert.includes(verdict.problems.join(' '), 'execve');
  });

  test('a standard interpreter passes', async (assert) => {
    await using directory = await tempDir('sea-verdict-good');
    const file = path.join(directory.path, 'fine');
    await fs.writeFile(file, elfNaming('/lib64/ld-linux-x86-64.so.2'));
    const verdict = await checkPortability(file);

    assert.true(verdict.portable);
    assert.deepEqual(verdict.problems, []);
  });

  test('a store path in the headers is caught even behind a standard interpreter', async (assert) => {
    // A RUNPATH is the other half: the loader is found, and then none of its libraries are.
    await using directory = await tempDir('sea-verdict-runpath');
    const file = path.join(directory.path, 'runpathed');
    const elf = elfNaming('/lib64/ld-linux-x86-64.so.2');
    await fs.writeFile(file, Buffer.concat([elf, Buffer.from('/nix/store/abc-zlib/lib\0')]));
    const verdict = await checkPortability(file);

    assert.false(verdict.portable);
    assert.includes(verdict.problems.join(' '), '/nix/store');
  });
});
