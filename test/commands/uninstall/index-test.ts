import fs from 'node:fs/promises';
import path from 'node:path';
import { module, test } from 'qunitx';
import { parseArgs, run, InvalidArgument } from '../../../lib/commands/uninstall/index.ts';
import { tempDir } from '../../helpers/temp-dir.ts';
import type { UninstallDeps } from '../../../lib/commands/uninstall/index.ts';
import '../../helpers/custom-asserts.ts';

// The command, with the world injected: what it says, what it removes, what it refuses, and the
// one thing it does before any of that — stopping a daemon that would outlive its own binary.

/** A console that keeps what it was told, and the deps every test below starts from. */
function context(deps: UninstallDeps = {}) {
  const said: string[] = [];
  const errors: string[] = [];
  const removed: string[] = [];
  const spawned: string[][] = [];
  let daemonStopped = false;

  return {
    said,
    errors,
    removed,
    spawned,
    get daemonStopped() {
      return daemonStopped;
    },
    output: () => said.join(''),
    deps: {
      console: {
        log: (text: string) => void said.push(text),
        error: (text: string) => void errors.push(text),
      },
      env: { HOME: '/home/u' },
      platform: 'linux' as NodeJS.Platform,
      exists: () => Promise.resolve(true),
      remove: (target: string) => {
        removed.push(target);

        return Promise.resolve();
      },
      spawn: (argv: string[]) => {
        spawned.push(argv);

        return Promise.resolve({ exitCode: 0, signalCode: null, isMissingInstallerBinary: false });
      },
      stopDaemon: () => {
        daemonStopped = true;

        return Promise.resolve(true);
      },
      confirm: () => Promise.resolve(true),
      ...deps,
    } satisfies UninstallDeps,
  };
}

const STANDALONE = {
  kind: 'standalone' as const,
  flavor: 'sea' as const,
  binaryPath: '/home/u/.qunitx/qunitx',
};

module('Commands | Uninstall | arguments', { concurrency: true }, () => {
  test('the flags it takes', (assert) => {
    const options = parseArgs(['--dry-run', '--yes', '--keep-cache', '--write-manifest']);

    assert.false(InvalidArgument.is(options));
    assert.deepEqual(options, {
      dryRun: true,
      yes: true,
      help: false,
      keepCache: true,
      writeManifest: true,
    });
    assert.true(InvalidArgument.is(parseArgs(['--yolo'])), 'and nothing else');
  });

  test('`-y` is `--yes`, and `-h` is the usage', (assert) => {
    const short = parseArgs(['-y']);

    assert.true(!InvalidArgument.is(short) && short.yes);
    const help = parseArgs(['-h']);
    assert.true(!InvalidArgument.is(help) && help.help);
  });

  test('--help prints the usage and removes nothing', async (assert) => {
    const it = context();
    const code = await run(['--help'], it.deps);

    assert.strictEqual(code, 0);
    assert.includes(it.output(), 'Usage: qunitx uninstall');
    assert.deepEqual(it.removed, []);
  });

  test('an argument it does not know is an exit 2, with the usage', async (assert) => {
    const it = context();
    const code = await run(['--yolo'], it.deps);

    assert.strictEqual(code, 2);
    assert.includes(it.errors.join(''), 'Unknown qunitx uninstall argument: --yolo');
  });
});

module('Commands | Uninstall | a standalone binary', { concurrency: true }, () => {
  test('--dry-run lists what would go and touches nothing', async (assert) => {
    const it = context({ channel: STANDALONE });
    const code = await run(['--dry-run'], it.deps);

    assert.strictEqual(code, 0);
    assert.includes(it.output(), '/home/u/.qunitx/qunitx');
    assert.includes(it.output(), '/home/u/.qunitx/esbuild');
    assert.deepEqual(it.removed, [], 'a dry run removes nothing');
    assert.false(it.daemonStopped, 'and stops nothing');
  });

  test('only what is actually there is listed', async (assert) => {
    // A glibc install has no `qunitx-musl/`, and saying it would remove one is a lie.
    const it = context({
      channel: STANDALONE,
      exists: (target: string) => Promise.resolve(!target.endsWith('qunitx-musl')),
    });
    await run(['--dry-run'], it.deps);

    assert.notIncludes(it.output(), 'qunitx-musl');
  });

  test('--yes removes the binary and its sidecar, daemon first', async (assert) => {
    const it = context({ channel: STANDALONE });
    const code = await run(['--yes'], it.deps);

    assert.strictEqual(code, 0);
    assert.true(it.daemonStopped, 'the daemon would have outlived the binary that stops it');
    assert.deepEqual(it.removed, [
      '/home/u/.qunitx/qunitx',
      '/home/u/.qunitx/esbuild',
      '/home/u/.qunitx/qunitx-musl',
    ]);
    assert.includes(it.output(), 'is uninstalled');
  });

  test('a declined question leaves everything alone', async (assert) => {
    const it = context({ channel: STANDALONE, confirm: () => Promise.resolve(false) });
    const code = await run([], it.deps);

    assert.strictEqual(code, 0, 'declining is not an error');
    assert.deepEqual(it.removed, []);
    assert.includes(it.output(), 'Left alone');
  });

  test('the question names everything it is about to do', async (assert) => {
    const asked: string[] = [];
    const it = context({
      channel: STANDALONE,
      confirm: (question: string) => {
        asked.push(question);

        return Promise.resolve(false);
      },
    });
    await run([], it.deps);

    assert.includes(asked.join(''), 'About to uninstall qunitx (the standalone Node binary)');
    assert.includes(asked.join(''), 'remove: /home/u/.qunitx/qunitx');
  });

  test('a removal that fails stops there, and says which one', async (assert) => {
    const it = context({
      channel: STANDALONE,
      remove: (target: string) =>
        target.endsWith('esbuild')
          ? Promise.reject(new Error('EACCES: permission denied'))
          : Promise.resolve(),
    });
    const code = await run(['--yes'], it.deps);

    assert.strictEqual(code, 2);
    assert.includes(it.errors.join(''), 'could not remove /home/u/.qunitx/esbuild');
    assert.includes(it.errors.join(''), 'EACCES');
  });
});

module('Commands | Uninstall | an install another tool owns', { concurrency: true }, () => {
  const JSR = {
    kind: 'jsr-launcher' as const,
    binaryPath: '/home/u/.cache/qunitx/0.37.3/linux-x64/qunitx',
    version: '0.37.3',
  };

  test('the JSR install runs deno’s uninstaller, then clears the cache', async (assert) => {
    const it = context({ channel: JSR });
    const code = await run(['--yes'], it.deps);

    assert.strictEqual(code, 0);
    assert.deepEqual(it.spawned, [['deno', 'uninstall', '-g', 'qunitx-cli']]);
    assert.deepEqual(it.removed, ['/home/u/.cache/qunitx']);
  });

  test('--keep-cache leaves the downloaded binaries where they are', async (assert) => {
    const it = context({ channel: JSR });
    const code = await run(['--yes', '--keep-cache'], it.deps);

    assert.strictEqual(code, 0);
    assert.deepEqual(it.removed, [], 'deno’s shim went; the cache stayed');
  });

  test('a global npm install is handed to npm', async (assert) => {
    const it = context({ channel: { kind: 'npm-global', prefix: '/usr/lib' } });
    const code = await run(['--yes'], it.deps);

    assert.strictEqual(code, 0);
    assert.deepEqual(it.spawned, [['npm', 'uninstall', '-g', 'qunitx-cli']]);
  });

  test('an uninstaller that fails takes its exit code, and nothing else is removed', async (assert) => {
    const it = context({
      channel: JSR,
      spawn: () =>
        Promise.resolve({ exitCode: 7, signalCode: null, isMissingInstallerBinary: false }),
    });
    const code = await run(['--yes'], it.deps);

    assert.strictEqual(code, 7);
    assert.deepEqual(it.removed, [], 'the cache stays until the shim is really gone');
    assert.includes(it.errors.join(''), 'deno exited 7');
  });

  test('an uninstaller that is not installed is an exit 2, not a crash', async (assert) => {
    const it = context({
      channel: JSR,
      spawn: () =>
        Promise.resolve({ exitCode: null, signalCode: null, isMissingInstallerBinary: true }),
    });
    const code = await run(['--yes'], it.deps);

    assert.strictEqual(code, 2);
    assert.includes(it.errors.join(''), 'deno is not installed');
  });

  test('QUNITX_NO_SELF_UPGRADE prints the command instead of running it', async (assert) => {
    const it = context({ channel: JSR, allowSelfUninstall: false });
    const code = await run(['--yes'], it.deps);

    assert.strictEqual(code, 1);
    assert.deepEqual(it.spawned, [], 'nothing was run on the user’s behalf');
    assert.includes(it.output(), 'deno uninstall -g qunitx-cli');
  });
});

module('Commands | Uninstall | what it will not do', { concurrency: true }, () => {
  test('a project dependency is refused, with both ways out', async (assert) => {
    const it = context({
      channel: { kind: 'npm-local', projectRoot: '/proj', manifest: '/proj/package.json' },
    });
    const code = await run([], it.deps);

    assert.strictEqual(code, 1);
    assert.includes(it.output(), 'npm uninstall --save-dev qunitx-cli');
    assert.includes(it.output(), '--write-manifest');
    assert.deepEqual(it.removed, []);
  });

  test('a source checkout is refused, and names no command at all', async (assert) => {
    const it = context({ channel: { kind: 'source', entry: '/repo/cli.ts' } });
    const code = await run([], it.deps);

    assert.strictEqual(code, 1);
    assert.includes(it.output(), 'source checkout');
    assert.notIncludes(it.output(), 'rm -rf', 'deleting a working tree is not a command it offers');
  });

  test('a deno-cache run is a clean zero: nothing was installed', async (assert) => {
    const it = context({ channel: { kind: 'deno-cache', entry: '/c/deno/npm/x' } });
    const code = await run([], it.deps);

    assert.strictEqual(code, 0);
    assert.includes(it.output(), 'nothing was installed');
    assert.deepEqual(it.removed, []);
  });
});

module('Commands | Uninstall | --write-manifest', { concurrency: true }, () => {
  test('takes the entry out of a package.json, and says which block', async (assert) => {
    await using dir = await tempDir('uninstall-manifest');
    const manifest = path.join(dir.path, 'package.json');
    await fs.writeFile(
      manifest,
      `${JSON.stringify({ name: 'p', devDependencies: { 'qunitx-cli': '^0.37.0', esbuild: '^0.28.0' } }, null, 2)}\n`,
    );
    const it = context({
      channel: { kind: 'npm-local', projectRoot: dir.path, manifest },
    });
    const code = await run(['--write-manifest'], it.deps);

    assert.strictEqual(code, 0);
    assert.includes(it.output(), 'devDependencies');
    const after = JSON.parse(await fs.readFile(manifest, 'utf8'));
    assert.deepEqual(after.devDependencies, { esbuild: '^0.28.0' }, 'and only that entry');
  });

  test('a manifest that never declared it says so, and is left as it was', async (assert) => {
    await using dir = await tempDir('uninstall-manifest-none');
    const manifest = path.join(dir.path, 'package.json');
    const before = `${JSON.stringify({ name: 'p', devDependencies: { esbuild: '^0.28.0' } }, null, 2)}\n`;
    await fs.writeFile(manifest, before);
    const it = context({ channel: { kind: 'npm-local', projectRoot: dir.path, manifest } });
    const code = await run(['--write-manifest'], it.deps);

    assert.strictEqual(code, 2);
    assert.includes(it.errors.join(''), 'No qunitx-cli entry');
    assert.strictEqual(await fs.readFile(manifest, 'utf8'), before, 'untouched');
  });
});
