import { module, test } from 'qunitx';
import { besideTheBinary, cacheRootFor, planFor } from '../../../lib/commands/uninstall/plan.ts';
import '../../helpers/custom-asserts.ts';

// One plan per install channel, decided without a filesystem. Six channels reach `uninstall`, and
// what separates them is who owns the files: qunitx, a package manager, or the person.

module('Commands | Uninstall | the plan per channel', { concurrency: true }, () => {
  test('a standalone binary is qunitx’s own, so qunitx removes it', (assert) => {
    const plan = planFor(
      { kind: 'standalone', flavor: 'sea', binaryPath: '/home/u/.qunitx/qunitx' },
      {},
      'linux',
    );

    assert.strictEqual(plan.kind, 'remove');
    assert.strictEqual(plan.argv, null, 'nothing else is asked to do it');
    assert.deepEqual(plan.removals, [
      '/home/u/.qunitx/qunitx',
      '/home/u/.qunitx/esbuild',
      '/home/u/.qunitx/qunitx-musl',
    ]);
  });

  test('the JSR install is deno’s shim plus our binary cache', (assert) => {
    const plan = planFor(
      {
        kind: 'jsr-launcher',
        binaryPath: '/home/u/.cache/qunitx/0.37.3/linux-x64/qunitx',
        version: '0.37.3',
      },
      { HOME: '/home/u' },
      'linux',
    );

    assert.strictEqual(plan.kind, 'run');
    assert.deepEqual(plan.argv, ['deno', 'uninstall', '-g', 'qunitx-cli']);
    assert.deepEqual(plan.removals, ['/home/u/.cache/qunitx'], 'the whole cache, every version');
  });

  test('a global npm install is npm’s to remove', (assert) => {
    const plan = planFor({ kind: 'npm-global', prefix: '/usr/lib' }, {}, 'linux');

    assert.strictEqual(plan.kind, 'run');
    assert.deepEqual(plan.argv, ['npm', 'uninstall', '-g', 'qunitx-cli']);
    assert.deepEqual(plan.removals, [], 'npm owns every file under its own prefix');
  });

  test('a project dependency is refused, with the command that would do it', (assert) => {
    const plan = planFor(
      { kind: 'npm-local', projectRoot: '/proj', manifest: '/proj/package.json' },
      {},
      'linux',
    );

    assert.strictEqual(plan.kind, 'refuse');
    assert.deepEqual(plan.argv, ['npm', 'uninstall', '--save-dev', 'qunitx-cli']);
    assert.strictEqual(plan.manifest, '/proj/package.json', 'which --write-manifest edits');
    assert.includes(plan.why, 'change to that project');
  });

  test('a deno project is refused the same way, through the registry it used', (assert) => {
    const deno = {
      kind: 'deno-project' as const,
      projectRoot: '/proj',
      manifest: '/proj/deno.json',
    };

    assert.deepEqual(planFor(deno, {}, 'linux', 'npm').argv, ['deno', 'remove', 'npm:qunitx-cli']);
    assert.deepEqual(planFor(deno, {}, 'linux', 'jsr').argv, [
      'deno',
      'remove',
      'jsr:@izelnakri/qunitx-cli',
    ]);
  });

  test('a deno-cache run installed nothing, so there is nothing to remove', (assert) => {
    const plan = planFor({ kind: 'deno-cache', entry: '/c/deno/npm/x' }, {}, 'linux');

    assert.strictEqual(plan.kind, 'nothing');
    assert.deepEqual(plan.removals, []);
    assert.includes(plan.why, 'nothing was installed');
  });

  test('a source checkout is a working tree, and git owns it', (assert) => {
    const plan = planFor({ kind: 'source', entry: '/repo/cli.ts' }, {}, 'linux');

    assert.strictEqual(plan.kind, 'refuse');
    assert.strictEqual(plan.argv, null, 'there is no command to print — deleting it is not one');
    assert.includes(plan.why, '/repo/cli.ts');
  });
});

module('Commands | Uninstall | where the binary cache lives', { concurrency: true }, () => {
  test('the same root the JSR launcher writes to', (assert) => {
    assert.strictEqual(cacheRootFor({ HOME: '/home/u' }, 'linux'), '/home/u/.cache/qunitx');
    assert.strictEqual(
      cacheRootFor({ HOME: '/home/u', XDG_CACHE_HOME: '/tmp/c' }, 'linux'),
      '/tmp/c/qunitx',
      'XDG_CACHE_HOME moves it, and this follows',
    );
    assert.strictEqual(
      cacheRootFor({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32'),
      'C:\\Users\\u\\AppData\\Local\\qunitx',
    );
    assert.strictEqual(
      cacheRootFor({ USERPROFILE: 'C:\\Users\\u' }, 'win32'),
      'C:\\Users\\u\\AppData\\Local\\qunitx',
      'without LOCALAPPDATA, the documented default',
    );
  });

  test('no home is no cache, rather than a guess at one', (assert) => {
    assert.strictEqual(cacheRootFor({}, 'linux'), null);
    assert.strictEqual(cacheRootFor({}, 'win32'), null);
  });
});

module('Commands | Uninstall | what sits beside the binary', { concurrency: true }, () => {
  test('the sidecar is named the way that platform names it', (assert) => {
    assert.deepEqual(besideTheBinary('C:\\tools\\qunitx.exe', 'win32'), [
      'C:\\tools\\qunitx.exe',
      'C:\\tools\\esbuild.exe',
      'C:\\tools\\qunitx-musl',
    ]);
  });
});
