import fs from 'node:fs/promises';
import { module, test } from 'qunitx';
import * as Release from '../../lib/commands/upgrade/release.ts';

// Four places name the standalone targets — the release matrices in ci.yml, install.sh, `qunitx
// upgrade`, and the jsr bootstrap — and nothing held them together. So CI built a linux-arm64
// binary on every release that install.sh then refused to install. Every installer's list is
// checked against what the release actually builds, in both directions: a target an installer
// offers with no build behind it is a 404, and a build no installer offers is wasted.

// Line endings normalised: a Windows checkout has CRLF (core.autocrlf), and the parsing below is
// line-based.
const read = async (file: string) => (await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n');
const CI = await read('.github/workflows/ci.yml');
const INSTALL_SH = await read('install.sh');
const JSR_BOOTSTRAP = await read('jsr/cli.ts');

/** What ci.yml's release jobs upload, by artifact name: `qunitx-deno-linux-arm64`, … */
const PUBLISHED = new Set([
  ...targetsOf('build-binaries').map((target) => `qunitx-${target}`),
  ...targetsOf('build-deno-binaries').map((target) => `qunitx-deno-${target}`),
  ...targetsOf('build-musl-binaries').map((target) => `qunitx-${target}`),
]);

const withoutExtension = (asset: string) => asset.replace(/\.(tar\.gz|zip)$/, '');

module('Bin | release targets', { concurrency: true }, () => {
  test('the release matrices were read', (assert) => {
    // Guards the parse below: an empty set would make every other assertion here vacuous.
    assert.true(PUBLISHED.has('qunitx-deno-linux-x64'), [...PUBLISHED].join(', '));
    assert.true(PUBLISHED.has('qunitx-linux-x64-musl'));
  });

  test('install.sh offers exactly the deno builds, and the musl build for each Linux one', (assert) => {
    const offered = installShTargets();

    assert.deepEqual(
      offered.map((target) => `qunitx-deno-${target}`).sort(),
      targetsOf('build-deno-binaries')
        .map((target) => `qunitx-deno-${target}`)
        .sort(),
      'no deno build left out, and none offered that is not built',
    );
    for (const target of offered.filter((one) => one.startsWith('linux-'))) {
      assert.true(PUBLISHED.has(`qunitx-${target}-musl`), `${target}-musl is built for Alpine`);
    }
  });

  test('the jsr bootstrap downloads only what is built, and every deno build', (assert) => {
    const archives = [...JSR_BOOTSTRAP.matchAll(/archive: '([^']+)'/g)].map(([, archive]) =>
      withoutExtension(archive!),
    );

    assert.deepEqual(
      archives.sort(),
      [...PUBLISHED].filter((name) => name.startsWith('qunitx-deno-')).sort(),
    );
  });

  test('qunitx upgrade asks only for assets the release has', (assert) => {
    const hosts: [NodeJS.Platform, string][] = [
      ['linux', 'x64'],
      ['linux', 'arm64'],
      ['darwin', 'x64'],
      ['darwin', 'arm64'],
      ['win32', 'x64'],
      ['win32', 'arm64'],
    ];
    const asked = new Set<string>();
    for (const flavor of ['sea', 'deno'] as const) {
      for (const [platform, arch] of hosts) {
        for (const libc of ['glibc', 'musl'] as const) {
          const asset = Release.assetName(flavor, platform, arch, libc);
          if (asset) asked.add(withoutExtension(asset));
        }
      }
    }

    for (const asset of asked) assert.true(PUBLISHED.has(asset), `${asset} is built`);
    for (const asset of PUBLISHED) assert.true(asked.has(asset), `${asset} can be upgraded to`);
  });
});

/** The `target:` values in one ci.yml job's matrix. */
function targetsOf(job: string): string[] {
  const start = CI.indexOf(`\n  ${job}:\n`);
  if (start === -1) throw new Error(`ci.yml has no ${job} job`);
  const rest = CI.slice(start + job.length + 4);
  const block = rest.slice(0, rest.search(/\n {2}[a-z][\w-]*:\n/));

  return [...block.matchAll(/^ {12}target: (\S+)$/gm)].map(([, target]) => target!);
}

/** The targets install.sh's `case "$TARGET" in` accepts. */
function installShTargets(): string[] {
  const accepted = INSTALL_SH.match(/case "\$TARGET" in\n\s*([\w|-]+)\) ;;/);
  if (!accepted) throw new Error('install.sh has no `case "$TARGET" in` list');

  return accepted[1]!.split('|');
}
