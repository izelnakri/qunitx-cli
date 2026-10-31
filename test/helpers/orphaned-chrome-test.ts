import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { planSweep, sweepOrphanedChrome, type ProcessEntry } from './orphaned-chrome.ts';
import { rmRetry } from './rm-retry.ts';

const entry = (pid: number, ppid: number, name: string, command = name): ProcessEntry => ({
  pid,
  ppid,
  pgid: pid,
  name,
  command,
});
const chrome = (pid: number, ppid: number, dir: string) =>
  entry(pid, ppid, 'chrome', `/usr/bin/chrome --user-data-dir=/tmp/${dir}`);

module('Helpers | orphaned Chrome sweep | plan', { concurrency: true }, () => {
  test('a Chrome some run still owns is left alone, with its renderers and its profile', (assert) => {
    const plan = planSweep(
      [
        entry(1, 0, 'systemd'),
        entry(10, 1, 'node', 'node cli.ts record a.html'),
        chrome(20, 10, 'qunitx-chrome-a'),
        chrome(21, 20, 'qunitx-chrome-a'),
        entry(30, 1, 'qunitx', '/usr/local/bin/qunitx test'),
        chrome(40, 30, 'qunitx-chrome-b'),
      ],
      ['qunitx-chrome-a', 'qunitx-chrome-b'],
    );

    assert.deepEqual(plan.orphans, [], "another runner's, a terminal's, a compiled binary's");
    assert.deepEqual([...plan.liveDirs].sort(), ['qunitx-chrome-a', 'qunitx-chrome-b']);
  });

  test('one whose launcher died is an orphan, reparented to init or a subreaper alike', (assert) => {
    const plan = planSweep(
      [
        entry(1, 0, 'systemd'),
        entry(5, 1, 'systemd', '/usr/lib/systemd/systemd --user'),
        chrome(20, 1, 'qunitx-chrome-a'),
        chrome(21, 20, 'qunitx-chrome-a'),
        chrome(30, 5, 'qunitx-chrome-b'),
      ],
      ['qunitx-chrome-a', 'qunitx-chrome-b'],
    );

    assert.deepEqual(
      plan.orphans.map((orphan) => orphan.pid),
      [20, 21, 30],
    );
    assert.deepEqual([...plan.liveDirs], [], 'their profiles are free to remove');
  });

  test('Windows names and a parent loop are handled; processes naming no profile are not looked at', (assert) => {
    const plan = planSweep(
      [
        entry(10, 4, 'node', 'C:\\node.exe cli.ts'),
        { ...chrome(20, 10, 'qunitx-chrome-a'), pgid: null },
        entry(50, 51, 'bash'),
        entry(51, 50, 'bash'),
        chrome(60, 50, 'qunitx-chrome-c'),
        entry(70, 1, 'vim', 'vim notes.txt'),
      ],
      ['qunitx-chrome-a', 'qunitx-chrome-c'],
    );

    assert.deepEqual(
      plan.orphans.map((orphan) => orphan.pid),
      [60],
    );
    assert.deepEqual([...plan.liveDirs], ['qunitx-chrome-a']);
  });
});

module('Helpers | orphaned Chrome sweep | real processes', { concurrency: true }, () => {
  // A stand-in Chrome: `sh` whose $0 names a profile, which is all the sweep reads. `& wait`, as
  // dash runs a script's last command with exec, replacing the command line that names it.
  async function fakeChrome(detach: boolean) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qunitx-chrome-sweep-'));
    const pidFile = path.join(dir, 'pid');
    const script = detach
      ? `setsid sh -c 'echo $$ > "${pidFile}"; sleep 60 & wait' "${dir}" & wait`
      : `echo $$ > "${pidFile}"; sleep 60 & wait`;
    const launcher = spawn('sh', ['-c', script, dir], { stdio: 'ignore' });
    let pid = 0;
    for (let tries = 0; !pid && tries < 100; tries++) {
      pid = Number(await fs.readFile(pidFile, 'utf8').catch(() => '0'));
      if (!pid) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return { dir, pid, launcher };
  }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  test('the sweep kills an orphan and removes its profile, and leaves an owned one running', async (assert) => {
    if (process.platform !== 'linux') return assert.ok(true, 'skipped: needs setsid');
    const owned = await fakeChrome(false);
    const orphan = await fakeChrome(true);
    // Its launcher gone, the orphan is reparented: the state a SIGKILLed CLI leaves behind.
    orphan.launcher.kill('SIGKILL');
    try {
      await sweepOrphanedChrome();

      assert.true(alive(owned.pid), 'the owned one still runs');
      assert.true(
        await fs.stat(owned.dir).then(
          () => true,
          () => false,
        ),
        'with its profile',
      );
      assert.false(alive(orphan.pid), 'the orphan is gone');
      assert.false(
        await fs.stat(orphan.dir).then(
          () => true,
          () => false,
        ),
        'and so is its profile',
      );
    } finally {
      for (const fake of [owned, orphan]) {
        if (alive(fake.pid)) process.kill(fake.pid, 'SIGKILL');
        await rmRetry(fake.dir);
      }
    }
  });
});
