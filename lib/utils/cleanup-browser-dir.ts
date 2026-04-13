import fs from 'node:fs/promises';

/**
 * Kills all surviving processes that reference `dirPath` (checked via both
 * /proc/PID/cwd and /proc/PID/cmdline), waits for them to exit, then retries
 * fs.rm() until it succeeds or a 1-second deadline expires.
 *
 * Call this after the caller's own phase-1 wait (browser main group / killedPids)
 * to handle renderer/GPU/utility subprocesses that have separate PGIDs and may
 * not die via PR_SET_PDEATHSIG reliably on loaded CI machines.
 *
 * Linux-only: falls back to a single best-effort rm() on other platforms.
 */
export async function cleanupBrowserDir(dirPath: string): Promise<void> {
  if (process.platform !== 'linux') {
    await fs.rm(dirPath, { recursive: true, force: true }).catch(() => {});
    return;
  }

  const dirName = dirPath.split('/').pop()!;

  // Phase 1: find and kill any process whose cwd is inside dirPath or whose
  // cmdline references it, then wait for all of them to fully exit.
  const killedPids = new Set<number>();
  const procEntries = await fs.readdir('/proc').catch(() => [] as string[]);
  await Promise.all(
    procEntries.map(async (entry) => {
      if (!/^\d+$/.test(entry)) return;
      const pid = parseInt(entry);
      try {
        const [cwd, cmdline] = await Promise.all([
          fs.readlink(`/proc/${entry}/cwd`).catch(() => ''),
          fs.readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => ''),
        ]);
        if (!cwd.startsWith(dirPath) && !cmdline.includes(dirName)) return;
        try {
          process.kill(pid, 'SIGKILL');
          killedPids.add(pid);
        } catch {
          /* ESRCH: already dead */
        }
      } catch {
        /* process entry vanished between readdir and read */
      }
    }),
  );

  while (killedPids.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const pid of killedPids) {
      try {
        process.kill(pid, 0);
      } catch {
        killedPids.delete(pid);
      } // ESRCH → dead
    }
  }

  // Phase 2: retry rm() until success or 1s deadline.
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const removed = await fs
      .rm(dirPath, { recursive: true, force: true })
      .then(() => true)
      .catch(() => false);
    if (removed) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  // Diagnostic: if still not removed, log which process holds the dir as cwd.
  if (
    await fs
      .access(dirPath)
      .then(() => true)
      .catch(() => false)
  ) {
    const diagEntries = await fs.readdir('/proc').catch(() => [] as string[]);
    await Promise.all(
      diagEntries.map(async (entry) => {
        if (!/^\d+$/.test(entry)) return;
        try {
          const cwd = await fs.readlink(`/proc/${entry}/cwd`).catch(() => '');
          if (!cwd.startsWith(dirPath)) return;
          const cmdline = await fs.readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '');
          process.stderr.write(
            `# [qunitx] cleanup failed: pid ${entry} still holds ${dirPath} as cwd` +
              ` (cmdline: ${cmdline.replace(/\0/g, ' ').slice(0, 120)})\n`,
          );
        } catch {
          /* vanished */
        }
      }),
    );
  }
}
