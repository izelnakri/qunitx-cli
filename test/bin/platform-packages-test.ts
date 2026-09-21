import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { module, test } from 'qunitx';
import '../helpers/custom-asserts.ts';

const NPM = path.join(process.cwd(), 'npm');

// The Linux SEA binaries link against glibc. A platform package that declares only `os` and `cpu`
// is installed on Alpine too, where its binary cannot start: 0.36.0's launcher died there with
// exit 254, and even with the fallback fixed it prints a warning on every run. `libc` is what npm
// reads to skip it on musl — verified on alpine:3.20, where a `libc: ["glibc"]` optional
// dependency is left out and the same package installs on Debian — so the JS CLI runs instead,
// without a word about it.
module('Bin | platform packages', { concurrency: true }, () => {
  test('every Linux package says it needs glibc', async (assert) => {
    const linux = (await manifests()).filter(({ os }) => os.includes('linux'));
    assert.ok(linux.length >= 2, 'found the Linux packages to check');

    for (const { name, libc } of linux) {
      assert.deepEqual(libc, ['glibc'], `${name} declares libc, or npm installs it on Alpine`);
    }
  });

  test('no other package says anything about libc, which only means something on Linux', async (assert) => {
    for (const { name, os, libc } of await manifests()) {
      if (os.includes('linux')) continue;
      assert.strictEqual(libc, undefined, `${name} has no libc to declare`);
    }
  });
});

/** Every `npm/<target>/package.json`, reduced to the fields npm uses to decide installability. */
async function manifests(): Promise<Array<{ name: string; os: string[]; libc?: string[] }>> {
  const targets = await fs.readdir(NPM, { withFileTypes: true });

  return Promise.all(
    targets
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const manifest = JSON.parse(
          await fs.readFile(path.join(NPM, entry.name, 'package.json'), 'utf8'),
        );

        return { name: manifest.name, os: manifest.os ?? [], libc: manifest.libc };
      }),
  );
}
