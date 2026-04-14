import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import os from 'node:os';
import shell from './helpers/shell.ts';

// Resource leak tests check global state (/tmp dirs, /proc, inotify counts).
// Tests within this module run sequentially; other test files may run concurrently.
module('resource leak tests', () => {
  test(
    'no orphaned Chrome user-data-dirs after a completed run',
    { skip: process.platform !== 'linux' },
    async (assert) => {
      // Snapshot dirs before our run — dirs already present belong to concurrent test files
      // (the suite runs with --test-concurrency=16) and must not be counted as our leak.
      const dirsBefore = new Set(
        (await fs.readdir(os.tmpdir())).filter((e) => e.startsWith('qunitx-chrome-')),
      );

      await shell('node cli.ts test/fixtures/passing-tests.ts');

      const entries = await fs.readdir(os.tmpdir());
      // Only dirs that appeared during our run (not pre-existing from concurrent tests).
      const chromeDirs = entries.filter(
        (e) => e.startsWith('qunitx-chrome-') && !dirsBefore.has(e),
      );
      if (chromeDirs.length === 0) {
        assert.ok(true, 'no Chrome dirs in tmpdir');
        return;
      }

      // Any qunitx-chrome-* dir that appeared during our run and is still present
      // after our CLI exits is genuinely orphaned by our run. Scan /proc to
      // produce a useful diagnostic: find which process (if any) holds it as cwd.
      const cwdHolders: string[] = [];
      const procEntries = await fs.readdir('/proc').catch(() => [] as string[]);
      await Promise.all(
        procEntries.map(async (entry) => {
          if (!/^\d+$/.test(entry)) return;
          try {
            const cwd = await fs.readlink(`/proc/${entry}/cwd`).catch(() => '');
            const matched = chromeDirs.find((d) => cwd.startsWith(`${os.tmpdir()}/${d}`));
            if (!matched) return;
            const cmdline = await fs.readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '');
            cwdHolders.push(
              `pid ${entry} cwd=${cwd} cmdline=${cmdline.replace(/\0/g, ' ').slice(0, 120)}`,
            );
          } catch {}
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
    },
  );

  // A Chrome process is orphaned when its parent node-cli was SIGKILL'd without
  // running the process-group shutdown. The kernel then reparents it to init (ppid=1).
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
