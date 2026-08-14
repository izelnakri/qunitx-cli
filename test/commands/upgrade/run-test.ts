import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as Upgrade from '../../../lib/commands/upgrade/index.ts';
import { Failure } from '../../../lib/result/index.ts';
import { streamConsole } from '../../../lib/console.ts';
import { tempDir } from '../../helpers/temp-dir.ts';
import type { InstallChannel } from '../../../lib/commands/upgrade/channel.ts';
import type { InstallPlan } from '../../../lib/commands/upgrade/install.ts';
import '../../helpers/custom-asserts.ts';

// The command itself: which channel gets an upgrade, which gets a refusal, and what each exit
// code means. Every seam is injected, so no test here reaches GitHub or replaces a file.

const LATEST = { tag: 'v0.35.0', version: '0.35.0', assets: [] };

const capture = () => {
  const lines: string[] = [];
  return { lines, console: streamConsole({ write: (text: string) => void lines.push(text) }) };
};

const CHANNELS: Record<string, InstallChannel> = {
  standalone: { kind: 'standalone', flavor: 'deno', binaryPath: '/home/dev/.qunitx/qunitx' },
  jsrLauncher: {
    kind: 'jsr-launcher',
    binaryPath: '/c/qunitx/0.34.5/linux-x86_64/qunitx',
    version: '0.34.5',
  },
  npmGlobal: { kind: 'npm-global', prefix: '/usr/lib' },
  npmLocal: { kind: 'npm-local', projectRoot: '/proj', manifest: '/proj/package.json' },
  denoCache: {
    kind: 'deno-cache',
    entry: '/home/dev/.cache/deno/npm/registry.npmjs.org/x/lib/x.ts',
  },
  source: { kind: 'source', entry: '/repo/cli.ts' },
};

module('Commands | Upgrade | run | reporting', { concurrency: true }, () => {
  test('--help prints usage and asks for nothing', async (assert) => {
    const { lines, console } = capture();
    let looked = false;

    const code = await Upgrade.run(['--help'], {
      console,
      find: () => {
        looked = true;
        return Promise.resolve(LATEST);
      },
    });

    assert.strictEqual(code, 0);
    assert.includes(lines.join(''), 'Usage: qunitx upgrade');
    assert.notOk(looked, 'help is answerable offline');
  });

  test('an unknown argument names itself, prints usage and exits 2', async (assert) => {
    const { lines, console } = capture();

    const code = await Upgrade.run(['--yolo'], { console });

    assert.strictEqual(code, 2);
    assert.includes(lines.join(''), '--yolo');
    assert.includes(lines.join(''), 'Usage: qunitx upgrade');
  });

  test('already current exits 0 and installs nothing', async (assert) => {
    const { lines, console } = capture();
    let installed = false;

    const code = await Upgrade.run([], {
      console,
      channel: CHANNELS.standalone,
      currentVersion: '0.35.0',
      find: () => Promise.resolve(LATEST),
      apply: () => {
        installed = true;
        return Promise.resolve([]);
      },
    });

    assert.strictEqual(code, 0);
    assert.includes(lines.join(''), 'already the latest version');
    assert.notOk(installed);
  });

  test('--check on a stale install exits 1 with the command for THIS channel', async (assert) => {
    const { lines, console } = capture();
    let installed = false;

    const code = await Upgrade.run(['--check'], {
      console,
      channel: CHANNELS.npmGlobal,
      currentVersion: '0.34.5',
      find: () => Promise.resolve(LATEST),
      apply: () => {
        installed = true;
        return Promise.resolve([]);
      },
    });

    assert.strictEqual(code, 1, 'a stale install is a non-zero exit, so CI can gate on it');
    assert.includes(lines.join(''), '0.34.5 → 0.35.0');
    assert.includes(lines.join(''), 'npm install -g qunitx-cli@0.35.0');
    assert.notOk(installed, '--check never installs');
  });

  test('--check on a current install exits 0', async (assert) => {
    const { lines, console } = capture();

    const code = await Upgrade.run(['--check'], {
      console,
      channel: CHANNELS.standalone,
      currentVersion: '0.35.0',
      find: () => Promise.resolve(LATEST),
    });

    assert.strictEqual(code, 0);
    assert.includes(lines.join(''), 'up to date');
  });

  test('a build ahead of the release line is not reported as stale', async (assert) => {
    const { lines, console } = capture();

    const code = await Upgrade.run([], {
      console,
      channel: CHANNELS.standalone,
      currentVersion: '0.36.0',
      find: () => Promise.resolve(LATEST),
    });

    assert.strictEqual(code, 0);
    assert.includes(lines.join(''), 'newer than the latest release');
  });

  test('a lookup it cannot answer exits 2, distinct from "you are stale"', async (assert) => {
    const { lines, console } = capture();

    const code = await Upgrade.run([], {
      console,
      channel: CHANNELS.standalone,
      currentVersion: '0.34.5',
      find: () => Promise.reject(new Error('fetch failed')),
    });

    assert.strictEqual(code, 2);
    assert.includes(lines.join(''), 'fetch failed');
  });
});

module('Commands | Upgrade | run | refusals', { concurrency: true }, () => {
  test('a source checkout refuses without a lookup, so it answers offline', async (assert) => {
    const { lines, console } = capture();
    let looked = false;

    const code = await Upgrade.run([], {
      console,
      channel: CHANNELS.source,
      currentVersion: '0.34.5',
      find: () => {
        looked = true;
        return Promise.resolve(LATEST);
      },
    });

    assert.strictEqual(code, 1);
    assert.includes(lines.join(''), 'git pull');
    assert.notOk(looked, 'git pull is the same answer at every version');
  });

  test('a devDependency is not silently mutated — it is told what to run', async (assert) => {
    const { lines, console } = capture();
    let installed = false;

    const code = await Upgrade.run([], {
      console,
      channel: CHANNELS.npmLocal,
      currentVersion: '0.34.5',
      find: () => Promise.resolve(LATEST),
      apply: () => {
        installed = true;
        return Promise.resolve([]);
      },
    });

    assert.strictEqual(code, 1);
    assert.includes(lines.join(''), 'npm install --save-dev qunitx-cli@0.35.0');
    assert.includes(lines.join(''), '--write-manifest');
    assert.notOk(installed, 'nothing in the project is touched');
  });

  test('a Deno project is told to deno add — never to npm install, and never git pull', async (assert) => {
    // The three refusals a Deno user used to get: `npm install -g` (a deno project has no
    // package.json above node_modules, which read as a global npm prefix), `npm install
    // --save-dev` (when it happened to have one), and `git pull` from the module cache.
    await using dir = await tempDir('upgrade-deno-refusal');
    const manifest = path.join(dir.path, 'deno.json');
    await fs.writeFile(
      manifest,
      JSON.stringify({ imports: { 'qunitx-cli': 'jsr:@izelnakri/qunitx-cli@^0.34.5' } }),
    );
    const { lines, console } = capture();

    const code = await Upgrade.run([], {
      console,
      channel: { kind: 'deno-project', projectRoot: dir.path, manifest },
      currentVersion: '0.34.5',
      find: () => Promise.resolve(LATEST),
    });
    const output = lines.join('');

    assert.strictEqual(code, 1);
    assert.includes(
      output,
      'deno add jsr:@izelnakri/qunitx-cli@0.35.0',
      'the registry comes from how the entry is actually pinned, so `deno add` updates it in place',
    );
    assert.notIncludes(output, 'npm install');
    assert.includes(output, '--write-manifest');
  });

  test('nothing is installed in the module cache, so nothing there can be upgraded', async (assert) => {
    const { lines, console } = capture();

    const code = await Upgrade.run([], {
      console,
      channel: CHANNELS.denoCache,
      currentVersion: '0.34.5',
      find: () => Promise.resolve(LATEST),
    });
    const output = lines.join('');

    assert.strictEqual(code, 1);
    assert.includes(output, 'deno run -A npm:qunitx-cli@0.35.0', 'asking for a version is the fix');
    assert.notIncludes(output, 'git pull', 'a cached module is not a checkout');
  });

  test('a global npm install points at npm, which owns those files', async (assert) => {
    const { lines, console } = capture();

    const code = await Upgrade.run([], {
      console,
      channel: CHANNELS.npmGlobal,
      currentVersion: '0.34.5',
      find: () => Promise.resolve(LATEST),
    });

    assert.strictEqual(code, 1);
    assert.includes(lines.join(''), 'npm install -g qunitx-cli@0.35.0');
  });

  test("the JSR launcher's cache is version-keyed, so it is reinstalled rather than overwritten", async (assert) => {
    const { lines, console } = capture();
    let installed = false;

    const code = await Upgrade.run([], {
      console,
      channel: CHANNELS.jsrLauncher,
      currentVersion: '0.34.5',
      find: () => Promise.resolve(LATEST),
      apply: () => {
        installed = true;
        return Promise.resolve([]);
      },
    });

    assert.strictEqual(code, 1);
    assert.includes(lines.join(''), 'deno install -Agf jsr:@izelnakri/qunitx-cli@0.35.0');
    assert.notOk(installed, 'a launcher pinned to 0.34.5 keeps getting 0.34.5');
  });
});

module('Commands | Upgrade | run | the standalone binary', { concurrency: true }, () => {
  test('downloads the asset matching this flavour and platform, then reports what it replaced', async (assert) => {
    const { lines, console } = capture();
    const plans: InstallPlan[] = [];

    const code = await Upgrade.run([], {
      console,
      channel: CHANNELS.standalone,
      currentVersion: '0.34.5',
      platform: 'linux',
      arch: 'arm64',
      find: () => Promise.resolve(LATEST),
      apply: (plan: InstallPlan) => {
        plans.push(plan);
        return Promise.resolve(['/home/dev/.qunitx/qunitx', '/home/dev/.qunitx/esbuild']);
      },
    });

    assert.strictEqual(code, 0);
    assert.strictEqual(plans.length, 1);
    assert.strictEqual(plans[0].assetName, 'qunitx-deno-linux-arm64.tar.gz');
    assert.strictEqual(plans[0].binaryPath, '/home/dev/.qunitx/qunitx');
    assert.includes(lines.join(''), '0.34.5 → 0.35.0');
    assert.includes(lines.join(''), 'replaced /home/dev/.qunitx/esbuild');
  });

  test('a SEA replaces itself in kind — with the SEA archive, not the deno one', async (assert) => {
    const { console } = capture();
    const plans: InstallPlan[] = [];

    const code = await Upgrade.run([], {
      console,
      channel: { kind: 'standalone', flavor: 'sea', binaryPath: '/opt/qunitx/qunitx' },
      currentVersion: '0.34.5',
      platform: 'linux',
      arch: 'x64',
      find: () => Promise.resolve(LATEST),
      apply: (plan: InstallPlan) => {
        plans.push(plan);
        return Promise.resolve(['/opt/qunitx/qunitx']);
      },
    });

    assert.strictEqual(code, 0);
    assert.strictEqual(plans[0].assetName, 'qunitx-linux-x64.tar.gz');
  });

  test('a platform with no published asset exits 2 without downloading anything', async (assert) => {
    const { lines, console } = capture();
    let installed = false;

    const code = await Upgrade.run([], {
      console,
      // A Node SEA on Intel macOS: build-binaries publishes macos-arm64 only.
      channel: { kind: 'standalone', flavor: 'sea', binaryPath: '/usr/local/bin/qunitx' },
      currentVersion: '0.34.5',
      platform: 'darwin',
      arch: 'x64',
      find: () => Promise.resolve(LATEST),
      apply: () => {
        installed = true;
        return Promise.resolve([]);
      },
    });

    assert.strictEqual(code, 2);
    assert.includes(lines.join(''), 'darwin-x64');
    assert.notOk(installed);
  });

  test('an install that fails exits 2 with the reason, not a stack', async (assert) => {
    const { lines, console } = capture();

    const code = await Upgrade.run([], {
      console,
      channel: CHANNELS.standalone,
      currentVersion: '0.34.5',
      platform: 'linux',
      arch: 'x64',
      find: () => Promise.resolve(LATEST),
      apply: () => Promise.reject(Failure.define('X', () => '/opt is not writable')({})),
    });

    assert.strictEqual(code, 2);
    assert.includes(lines.join(''), '/opt is not writable');
  });

  test('--force reinstalls the version already running', async (assert) => {
    const { console } = capture();
    let installed = false;

    const code = await Upgrade.run(['--force'], {
      console,
      channel: CHANNELS.standalone,
      currentVersion: '0.35.0',
      platform: 'linux',
      arch: 'x64',
      find: () => Promise.resolve(LATEST),
      apply: () => {
        installed = true;
        return Promise.resolve(['/home/dev/.qunitx/qunitx']);
      },
    });

    assert.strictEqual(code, 0);
    assert.ok(installed, 'the repair case: same version, fresh bytes');
  });

  test('a pinned older version is installed, because a downgrade was asked for explicitly', async (assert) => {
    const { lines, console } = capture();
    const requested: (string | undefined)[] = [];
    let installed = false;

    const code = await Upgrade.run(['0.34.2'], {
      console,
      channel: CHANNELS.standalone,
      currentVersion: '0.34.5',
      platform: 'linux',
      arch: 'x64',
      find: (version?: string) => {
        requested.push(version);
        return Promise.resolve({ tag: 'v0.34.2', version: '0.34.2', assets: [] });
      },
      apply: () => {
        installed = true;
        return Promise.resolve(['/home/dev/.qunitx/qunitx']);
      },
    });

    assert.strictEqual(code, 0);
    assert.deepEqual(requested, ['0.34.2']);
    assert.ok(installed);
    assert.includes(lines.join(''), '0.34.5 → 0.34.2');
  });
});

module('Commands | Upgrade | run | --write-manifest', { concurrency: true }, () => {
  test('bumps the range in the npm project it found, and leaves the install to the user', async (assert) => {
    await using dir = await tempDir('upgrade-manifest-npm');
    const manifest = path.join(dir.path, 'package.json');
    await fs.writeFile(
      manifest,
      `${JSON.stringify({ name: 'proj', devDependencies: { 'qunitx-cli': '^0.34.5' } }, null, 2)}\n`,
    );
    const { lines, console } = capture();

    const code = await Upgrade.run(['--write-manifest'], {
      console,
      channel: { kind: 'npm-local', projectRoot: dir.path, manifest },
      currentVersion: '0.34.5',
      find: () => Promise.resolve(LATEST),
    });

    assert.strictEqual(code, 0);
    assert.strictEqual(
      JSON.parse(await fs.readFile(manifest, 'utf8')).devDependencies['qunitx-cli'],
      '^0.35.0',
    );
    assert.includes(lines.join(''), 'npm install');
  });

  test('a deno project gets its deno.json bumped, and is told to run deno install', async (assert) => {
    // One flag, not one per manifest: which file declares the dependency is a fact about the
    // project, and the channel already established it.
    await using dir = await tempDir('upgrade-manifest-deno');
    const manifest = path.join(dir.path, 'deno.json');
    await fs.writeFile(
      manifest,
      JSON.stringify({ imports: { 'qunitx-cli': 'npm:qunitx-cli@~0.34.5' } }),
    );
    const { lines, console } = capture();

    const code = await Upgrade.run(['--write-manifest'], {
      console,
      channel: { kind: 'deno-project', projectRoot: dir.path, manifest },
      currentVersion: '0.34.5',
      find: () => Promise.resolve(LATEST),
    });

    assert.strictEqual(code, 0);
    assert.strictEqual(
      JSON.parse(await fs.readFile(manifest, 'utf8')).imports['qunitx-cli'],
      'npm:qunitx-cli@~0.35.0',
    );
    assert.includes(lines.join(''), 'deno install');
  });

  test('refuses on any channel with no manifest to speak for', async (assert) => {
    const { lines, console } = capture();

    const code = await Upgrade.run(['--write-manifest'], {
      console,
      channel: CHANNELS.standalone,
      currentVersion: '0.34.5',
      find: () => Promise.resolve(LATEST),
    });

    assert.strictEqual(code, 2);
    assert.includes(lines.join(''), 'a standalone binary');
  });

  test('a manifest that declares nothing to bump exits 2 rather than inventing an entry', async (assert) => {
    await using dir = await tempDir('upgrade-manifest-empty');
    const manifest = path.join(dir.path, 'deno.json');
    await fs.writeFile(manifest, JSON.stringify({ imports: {} }));
    const { lines, console } = capture();

    const code = await Upgrade.run(['--write-manifest'], {
      console,
      channel: { kind: 'deno-project', projectRoot: dir.path, manifest },
      currentVersion: '0.34.5',
      find: () => Promise.resolve(LATEST),
    });

    assert.strictEqual(code, 2);
    assert.includes(lines.join(''), 'No pinned qunitx-cli version found');
  });
});

module('Commands | Upgrade | parseArgs', { concurrency: true }, () => {
  test('a bare version pins, with or without its v', (assert) => {
    for (const argv of [['0.34.2'], ['v0.34.2'], ['--version=0.34.2'], ['--version=v0.34.2']]) {
      const options = Upgrade.parseArgs(argv);
      assert.strictEqual(Failure.is(options) ? null : options.version, '0.34.2');
    }
  });

  test('flags compose, and anything else is refused by name', (assert) => {
    const options = Upgrade.parseArgs(['--check', '--force', '0.1.0']);
    assert.deepEqual(options, {
      check: true,
      force: true,
      help: false,
      writeManifest: false,
      version: '0.1.0',
    });

    const failure = Upgrade.parseArgs(['--dry-run']);
    assert.ok(Failure.is(failure) && failure.code === 'InvalidUpgradeArgument');
  });
});
