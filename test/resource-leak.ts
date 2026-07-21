import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import os from 'node:os';
import { execute as shell } from './helpers/shell.ts';

// Must exceed CLEANUP_DEADLINE_MS (5 s) so concurrent tests' in-flight cleanups finish.
const CHROME_DIR_POLL_TIMEOUT_MS = 10_000;

// Resource leak tests check global state (/tmp dirs, /proc, inotify counts).
// Tests within this module run sequentially; other test files may run concurrently.
module('Resource leaks', () => {
  // Both halves of "the run cleaned up after itself" — the user-data-dir on disk and the
  // Chrome process in /proc — are read off the same completed run. They used to be two
  // tests spawning two identical runs, which in an exclusive phase is a browser launch
  // spent to learn nothing new.
  test(
    'a completed run leaves behind neither a Chrome user-data-dir nor an orphaned process',
    { skip: process.platform !== 'linux' },
    async (assert) => {
      // Snapshot dirs before our run — dirs already present belong to concurrent test files
      // and must not be counted as our leak.
      const dirsBefore = new Set(
        (await fs.readdir(os.tmpdir())).filter((e) => e.startsWith('qunitx-chrome-')),
      );

      await shell('node cli.ts test/fixtures/passing-tests.ts');

      // Poll until all new Chrome dirs disappear, up to 10 s. The window must exceed
      // CLEANUP_DEADLINE_MS (5 s) so that a concurrent test whose cleanup is still in
      // progress when our CLI exits has time to finish. Our own dir is always cleaned up
      // before process.exit() fires (shutdownPrelaunch() is awaited); any dirs that linger
      // longer than 10 s are genuine leaks.
      const chromeDirs = await (async function poll(deadline: number): Promise<string[]> {
        const dirs = (await fs.readdir(os.tmpdir())).filter(
          (e) => e.startsWith('qunitx-chrome-') && !dirsBefore.has(e),
        );
        if (dirs.length === 0 || Date.now() >= deadline) return dirs;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return poll(deadline);
      })(Date.now() + CHROME_DIR_POLL_TIMEOUT_MS);

      // One /proc walk answers both questions: which process still holds a leaked dir as
      // cwd (the diagnostic for the dir assertion), and which Chrome has been reparented
      // to init (the orphan assertion). A Chrome is orphaned when its parent node-cli was
      // SIGKILL'd without running the process-group shutdown, so the kernel reparents it.
      const cwdHolders: string[] = [];
      const orphans: string[] = [];
      const procEntries = await fs.readdir('/proc').catch(() => [] as string[]);
      await Promise.all(
        procEntries.map(async (entry) => {
          if (!/^\d+$/.test(entry)) return;
          try {
            const cwd = await fs.readlink(`/proc/${entry}/cwd`).catch(() => '');
            const matched = chromeDirs.find((d) => cwd.startsWith(`${os.tmpdir()}/${d}`));
            const cmdline = await fs.readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '');
            if (matched) {
              cwdHolders.push(
                `pid ${entry} cwd=${cwd} cmdline=${cmdline.replace(/\0/g, ' ').slice(0, 120)}`,
              );
            }
            if (!cmdline.includes('qunitx-chrome-')) return;
            const status = await fs.readFile(`/proc/${entry}/status`, 'utf8');
            const ppidMatch = status.match(/^PPid:\s+(\d+)/m);
            if (ppidMatch && parseInt(ppidMatch[1]) === 1) orphans.push(entry);
          } catch {
            /* /proc entry vanished mid-scan */
          }
        }),
      );

      const detail =
        cwdHolders.length > 0
          ? `\n  processes still holding dirs as cwd:\n  ${cwdHolders.join('\n  ')}`
          : '\n  no process found holding these dirs as cwd (rm() failed silently)';
      assert.equal(
        chromeDirs.length,
        0,
        `Chrome dirs not cleaned up after completed run: ${chromeDirs.join(', ')}${detail}`,
      );
      assert.equal(
        orphans.length,
        0,
        `Chrome PIDs reparented to init (parent node-cli was SIGKILL'd): ${orphans.join(', ')}`,
      );
    },
  );

  // inotify instances must not grow after repeated runs. Each Chrome process group
  // opens ~10–20 inotify instances across its subprocesses; the group kill must
  // release them all. A regression here means subprocesses escape the kill.
  test(
    'inotify instances do not accumulate across runs',
    { skip: process.platform !== 'linux' },
    async (assert) => {
      const readCount = () =>
        fs
          .readFile('/proc/sys/fs/inotify/nr_inotify_instances', 'utf8')
          .then((s) => parseInt(s.trim()))
          .catch(() => null);

      const before = await readCount();
      if (before === null) {
        assert.ok(true, '/proc/sys/fs/inotify/nr_inotify_instances not available on this system');
        return;
      }

      // Concurrent rather than sequential: the count is only read once every run has exited,
      // so ordering cannot change the verdict, and three overlapping process groups are if
      // anything a harsher test of the group kill than three consecutive ones.
      await Promise.all([
        shell('node cli.ts test/fixtures/passing-tests.ts'),
        shell('node cli.ts test/fixtures/passing-tests.ts'),
        shell('node cli.ts test/fixtures/passing-tests.ts'),
      ]);
      const after = (await readCount())!;

      // Allow ±5 for unrelated system activity during a concurrent test run.
      assert.ok(
        after - before <= 5,
        `inotify instances grew from ${before} → ${after} (+${after - before}); Chrome subprocesses may be escaping the group kill`,
      );
    },
  );
});
