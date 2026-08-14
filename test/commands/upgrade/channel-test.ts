import { module, test } from 'qunitx';
import * as Channel from '../../../lib/commands/upgrade/channel.ts';
import '../../helpers/custom-asserts.ts';

// Channel detection is the whole of `upgrade`'s decision, and every input it reads is injectable —
// so every install shape is asserted here without any of them existing on this machine.

const never = () => false;
const always = () => true;

module('Commands | Upgrade | Channel.detect', { concurrency: true }, () => {
  test('a downloaded binary owns its own path', (assert) => {
    const channel = Channel.detect({
      execPath: '/home/dev/.qunitx/qunitx',
      platform: 'linux',
      isDeno: true,
      fileExists: never,
    });

    assert.deepEqual(channel, {
      kind: 'standalone',
      flavor: 'deno',
      binaryPath: '/home/dev/.qunitx/qunitx',
    });
  });

  test('flavor follows the runtime, because the two build matrices publish different targets', (assert) => {
    const sea = Channel.detect({
      execPath: '/opt/qunitx/qunitx',
      platform: 'linux',
      isDeno: false,
      fileExists: never,
    });

    assert.strictEqual(sea.kind === 'standalone' && sea.flavor, 'sea');
  });

  test('the JSR launcher cache is recognised by its version-keyed layout, wherever it lives', (assert) => {
    for (const root of ['/home/dev/.cache', '/var/xdg-cache', 'C:/Users/dev/AppData/Local']) {
      const channel = Channel.detect({
        execPath: `${root}/qunitx/0.34.5/linux-x86_64/qunitx`,
        platform: 'linux',
        fileExists: never,
      });

      assert.deepEqual(channel, {
        kind: 'jsr-launcher',
        binaryPath: `${root}/qunitx/0.34.5/linux-x86_64/qunitx`,
        version: '0.34.5',
      });
    }
  });

  test('a directory that merely looks cache-shaped is not the cache', (assert) => {
    // `<root>/qunitx/<semver>/<os>-<arch>/qunitx` is the whole contract, and every part of it
    // carries weight: a hand-made layout that misses any one is a standalone install someone
    // owns, and taking it for the launcher's cache would refuse an upgrade it can perform.
    const nearMisses = [
      '/opt/qunitx/latest/qunitx', // no version level at all
      '/opt/tools/qunitx/nightly/linux-x64/qunitx', // version is not a version
      '/opt/tools/qunitx/1.0.0/stable/qunitx', // that level is not an os-arch key
      '/opt/tools/binaries/1.0.0/linux-x64/qunitx', // not under a directory called qunitx
    ];

    for (const execPath of nearMisses) {
      assert.strictEqual(
        Channel.detect({ execPath, platform: 'linux', fileExists: never }).kind,
        'standalone',
        `${execPath} is a standalone install`,
      );
    }
  });

  test('the SEA npm spawns out of an optional platform package is npm-owned, not standalone', (assert) => {
    // bin/qunitx.js prefers this binary over dist/cli.js, so the running executable IS a SEA —
    // but the files under it belong to npm, and replacing one would be undone by the next install.
    const channel = Channel.detect({
      execPath: '/proj/node_modules/qunitx-cli-linux-x64/bin/qunitx',
      platform: 'linux',
      fileExists: (target: string) => target === '/proj/package.json',
    });

    assert.deepEqual(channel, {
      kind: 'npm-local',
      projectRoot: '/proj',
      manifest: '/proj/package.json',
    });
  });

  test('a global npm prefix has no manifest of any kind above node_modules', (assert) => {
    assert.deepEqual(
      Channel.detect({
        execPath: '/usr/bin/node',
        modulePath: '/usr/lib/node_modules/qunitx-cli/lib/commands/upgrade/channel.ts',
        platform: 'linux',
        fileExists: never,
      }),
      { kind: 'npm-global', prefix: '/usr/lib' },
    );
  });

  test("Windows' global npm layout resolves with win32 path rules", (assert) => {
    assert.deepEqual(
      Channel.detect({
        execPath: 'C:\\Program Files\\nodejs\\node.exe',
        modulePath: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\qunitx-cli\\dist\\cli.js',
        platform: 'win32',
        fileExists: never,
      }),
      { kind: 'npm-global', prefix: 'C:\\Users\\dev\\AppData\\Roaming\\npm' },
    );
  });

  test("pnpm's nested store resolves to the project, not to the store directory", (assert) => {
    // The nearest node_modules is inside .pnpm and has no project above it; the OUTERMOST one does.
    const channel = Channel.detect({
      execPath: '/usr/bin/node',
      modulePath: '/proj/node_modules/.pnpm/qunitx-cli@0.34.5/node_modules/qunitx-cli/dist/cli.js',
      platform: 'linux',
      fileExists: (target: string) => target === '/proj/package.json',
    });

    assert.deepEqual(channel, {
      kind: 'npm-local',
      projectRoot: '/proj',
      manifest: '/proj/package.json',
    });
  });

  test("deno's node_modules/.deno layout is a deno project, whatever manifests sit above it", (assert) => {
    // The bug this pins: `deno install` produces a node_modules with no package.json above it,
    // which read exactly like a global npm prefix — so a Deno user was told to `npm install -g`.
    // The `.deno` segment is deno's own and nothing else writes it, so it settles the question
    // before any manifest is consulted.
    const modulePath =
      '/proj/node_modules/.deno/qunitx-cli@0.34.5/node_modules/qunitx-cli/lib/commands/upgrade/channel.ts';

    assert.deepEqual(
      Channel.detect({
        execPath: '/usr/bin/deno',
        modulePath,
        platform: 'linux',
        fileExists: never,
      }),
      { kind: 'deno-project', projectRoot: '/proj', manifest: '/proj/package.json' },
      'no manifest found: the write still has a path to report on',
    );
    assert.deepEqual(
      Channel.detect({
        execPath: '/usr/bin/deno',
        modulePath,
        platform: 'linux',
        // A deno project that also carries a package.json used to come out npm-local, and would
        // have been told to run `npm install --save-dev`.
        fileExists: (target: string) =>
          target === '/proj/package.json' || target === '/proj/deno.json',
      }),
      { kind: 'deno-project', projectRoot: '/proj', manifest: '/proj/deno.json' },
      'deno.json wins over package.json, because deno is what installed this',
    );
  });

  test('a deno.json above node_modules is a deno project even without the .deno layout', (assert) => {
    for (const manifest of ['deno.json', 'deno.jsonc']) {
      assert.deepEqual(
        Channel.detect({
          execPath: '/usr/bin/deno',
          modulePath: '/proj/node_modules/qunitx-cli/lib/commands/upgrade/channel.ts',
          platform: 'linux',
          fileExists: (target: string) => target === `/proj/${manifest}`,
        }),
        { kind: 'deno-project', projectRoot: '/proj', manifest: `/proj/${manifest}` },
      );
    }
  });

  test("deno's module cache is a run, not an install — on either OS and under DENO_DIR", (assert) => {
    const cached = [
      '/home/dev/.cache/deno/npm/registry.npmjs.org/qunitx-cli/0.34.5/lib/commands/upgrade/channel.ts',
      '/home/dev/.cache/deno/remote/https/jsr.io/@izelnakri/qunitx-cli/0.34.5/lib/x.ts',
      'C:\\Users\\dev\\AppData\\Local\\deno\\npm\\registry.npmjs.org\\qunitx-cli\\0.34.5\\lib\\x.ts',
    ];

    for (const modulePath of cached) {
      assert.strictEqual(
        Channel.detect({ execPath: '/usr/bin/deno', modulePath, fileExists: never }).kind,
        'deno-cache',
        `${modulePath} is a cached module`,
      );
    }

    // A relocated DENO_DIR has none of those markers, so the env var is read rather than guessed.
    assert.strictEqual(
      Channel.detect({
        execPath: '/usr/bin/deno',
        modulePath: '/var/lib/dcache/npm/mirror.internal/qunitx-cli/0.34.5/lib/x.ts',
        denoDir: '/var/lib/dcache',
        fileExists: never,
      }).kind,
      'deno-cache',
    );
  });

  test('a source checkout is anything the runtime runs from outside node_modules', (assert) => {
    assert.deepEqual(
      Channel.detect({
        execPath: '/usr/bin/node',
        modulePath: '/repo/lib/commands/upgrade/channel.ts',
        platform: 'linux',
        fileExists: always,
      }),
      { kind: 'source', entry: '/repo/lib/commands/upgrade/channel.ts' },
    );
  });

  test('detect() answers for this very process without any injection', (assert) => {
    // Running under `node cli.ts` / `deno test` from the checkout, which is the source channel.
    assert.strictEqual(Channel.detect().kind, 'source');
  });
});

module('Commands | Upgrade | Channel.updateCommand', { concurrency: true }, () => {
  test('each channel names the tool that actually owns the install', (assert) => {
    assert.strictEqual(
      Channel.updateCommand({ kind: 'npm-global', prefix: '/usr/lib' }, '1.2.3'),
      'npm install -g qunitx-cli@1.2.3',
    );
    assert.strictEqual(
      Channel.updateCommand(
        { kind: 'npm-local', projectRoot: '/proj', manifest: '/proj/package.json' },
        '1.2.3',
      ),
      'npm install --save-dev qunitx-cli@1.2.3',
    );
    assert.strictEqual(
      Channel.updateCommand({ kind: 'deno-cache', entry: '/c/deno/npm/x/lib/x.ts' }, '1.2.3'),
      'deno run -A npm:qunitx-cli@1.2.3',
    );
    assert.strictEqual(
      Channel.updateCommand(
        { kind: 'jsr-launcher', binaryPath: '/c/qunitx', version: '1.0.0' },
        '1.2.3',
      ),
      'deno install -Agf jsr:@izelnakri/qunitx-cli@1.2.3',
    );
    assert.strictEqual(
      Channel.updateCommand({ kind: 'source', entry: '/repo/cli.ts' }, '1.2.3'),
      'git pull',
    );
    assert.strictEqual(
      Channel.updateCommand(
        { kind: 'standalone', flavor: 'deno', binaryPath: '/b/qunitx' },
        '1.2.3',
      ),
      'qunitx upgrade 1.2.3',
    );
  });

  test('a deno project is told to update the entry it has, not to add a second one', (assert) => {
    const channel = {
      kind: 'deno-project',
      projectRoot: '/proj',
      manifest: '/proj/deno.json',
    } as const;

    assert.strictEqual(
      Channel.updateCommand(channel, '1.2.3', 'npm'),
      'deno add npm:qunitx-cli@1.2.3',
    );
    assert.strictEqual(
      Channel.updateCommand(channel, '1.2.3', 'jsr'),
      'deno add jsr:@izelnakri/qunitx-cli@1.2.3',
    );
    assert.strictEqual(
      Channel.updateCommand(channel, '1.2.3'),
      'deno add npm:qunitx-cli@1.2.3',
      'npm is the default, matching what a bare `deno add qunitx-cli` resolves to',
    );
  });
});
