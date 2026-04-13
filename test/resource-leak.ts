import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import os from 'node:os';
import shell from './helpers/shell.ts';

module('resource leak tests', { concurrency: true }, () => {
  // A Chrome dir is orphaned only if no process in /proc still references it.
  // Dirs from concurrently-running other tests are excluded because their active
  // Chrome processes appear in /proc cmdlines — they are not orphans.
  test(
    'no orphaned Chrome user-data-dirs after a completed run',
    { skip: process.platform !== 'linux' },
    async (assert) => {
      await shell('node cli.ts test/fixtures/passing-tests.ts');

      const entries = await fs.readdir(os.tmpdir());
      const chromeDirs = entries.filter((e) => e.startsWith('qunitx-chrome-'));
      if (chromeDirs.length === 0) {
        assert.ok(true, 'no Chrome dirs in tmpdir');
        return;
      }

      // Build the set of dirs still held by a live process. Any dir not in this
      // set has no owner — it was never cleaned up after its Chrome was killed.
      const procEntries = await fs.readdir('/proc');
      const activeDirs = new Set<string>();
      await Promise.all(
        procEntries.map(async (entry) => {
          if (!/^\d+$/.test(entry)) return;
          try {
            const cmdline = await fs.readFile(`/proc/${entry}/cmdline`, 'utf8');
            for (const dir of chromeDirs) {
              if (cmdline.includes(dir)) activeDirs.add(dir);
            }
          } catch {}
        }),
      );

      const orphaned = chromeDirs.filter((d) => !activeDirs.has(d));
      assert.equal(
        orphaned.length,
        0,
        `Chrome dirs with no live process holding them: ${orphaned.join(', ')}`,
      );
    },
  );

  // A Chrome process is orphaned when its parent node-cli was SIGKILL'd without
  // running the process-group shutdown. The kernel then reparents it to init (ppid=1).
  // Active Chrome from concurrent tests still has a live node parent (ppid > 1).
  test(
    'no orphaned Chrome processes in /proc after a completed run',
    { skip: process.platform !== 'linux' },
    async (assert) => {
      await shell('node cli.ts test/fixtures/passing-tests.ts');

      const procEntries = await fs.readdir('/proc');
      const orphans: string[] = [];
      await Promise.all(
        procEntries.map(async (entry) => {
          if (!/^\d+$/.test(entry)) return;
          try {
            const cmdline = await fs.readFile(`/proc/${entry}/cmdline`, 'utf8');
            if (!cmdline.includes('qunitx-chrome-')) return;
            const status = await fs.readFile(`/proc/${entry}/status`, 'utf8');
            const ppidMatch = status.match(/^PPid:\s+(\d+)/m);
            if (ppidMatch && parseInt(ppidMatch[1]) === 1) orphans.push(entry);
          } catch {}
        }),
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

      await shell('node cli.ts test/fixtures/passing-tests.ts');
      await shell('node cli.ts test/fixtures/passing-tests.ts');
      await shell('node cli.ts test/fixtures/passing-tests.ts');
      const after = (await readCount())!;

      // Allow ±5 for unrelated system activity during a concurrent test run.
      assert.ok(
        after - before <= 5,
        `inotify instances grew from ${before} → ${after} (+${after - before}); Chrome subprocesses may be escaping the group kill`,
      );
    },
  );
});
