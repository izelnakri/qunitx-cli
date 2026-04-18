import fs from 'node:fs/promises';

// Returns true if the process at /proc/$entry references dirPath via cwd, cmdline, or open FDs.
// Chrome's sandboxed renderer/GPU processes run in separate process groups with cwd='/' and
// no dir name in cmdline, but they inherit file descriptors to the user-data-dir from the
// browser main process. Without the FD check, those processes are missed and rm() fails
// with EBUSY even though no process has the dir as its working directory.
async function processReferencesDir(
  entry: string,
  dirPath: string,
  dirName: string,
): Promise<boolean> {
  try {
    const [cwd, cmdline] = await Promise.all([
      fs.readlink(`/proc/${entry}/cwd`).catch(() => ''),
      fs.readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => ''),
    ]);
    if (cwd.startsWith(dirPath) || cmdline.includes(dirName)) return true;

    const fds = await fs.readdir(`/proc/${entry}/fd`).catch(() => [] as string[]);
    const fdTargets = await Promise.all(
      fds.map((fd) => fs.readlink(`/proc/${entry}/fd/${fd}`).catch(() => '')),
    );
    return fdTargets.some((target) => target.startsWith(dirPath));
  } catch {
    return false;
  }
}

async function killAndAwait(pids: Set<number>): Promise<void> {
  while (pids.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const pid of pids) {
      try {
        process.kill(pid, 0);
      } catch {
        pids.delete(pid);
      }
    }
  }
}

// Scans /proc, kills every process referencing dirPath, returns the killed pid set.
async function killAllReferencingProcesses(dirPath: string, dirName: string): Promise<Set<number>> {
  const killedPids = new Set<number>();
  const procEntries = await fs.readdir('/proc').catch(() => [] as string[]);
  await Promise.all(
    procEntries.map(async (entry) => {
      if (!/^\d+$/.test(entry)) return;
      const pid = parseInt(entry);
      if (!(await processReferencesDir(entry, dirPath, dirName))) return;
      try {
        process.kill(pid, 'SIGKILL');
        killedPids.add(pid);
      } catch {
        /* ESRCH: already dead */
      }
    }),
  );
  return killedPids;
}

/**
 * Kills all surviving processes that reference `dirPath` (checked via cwd, cmdline,
 * and open file descriptors), waits for them to exit, then retries fs.rm() until it
 * succeeds or a 5-second deadline expires. Re-scans /proc on each failed rm() attempt
 * to catch processes that appear after the initial scan (e.g. late-forked Chrome helpers).
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

  // Phase 1: find and kill every process referencing the dir (cwd, cmdline, or open FD).
  await killAndAwait(await killAllReferencingProcesses(dirPath, dirName));

  // Phase 2: retry rm() until success or 5s deadline.
  // Re-scan /proc on each failure — new Chrome helper processes may appear after the
  // initial kill pass (late-forked GPU helpers, zygote children, etc.).
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const removed = await fs
      .rm(dirPath, { recursive: true, force: true })
      .then(() => true)
      .catch(() => false);
    if (removed) break;
    await killAndAwait(await killAllReferencingProcesses(dirPath, dirName));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  // Diagnostic: if still not removed, log any process still holding the dir.
  if (
    !(await fs
      .access(dirPath)
      .then(() => true)
      .catch(() => false))
  )
    return;
  const diagEntries = await fs.readdir('/proc').catch(() => [] as string[]);
  await Promise.all(
    diagEntries.map(async (entry) => {
      if (!/^\d+$/.test(entry)) return;
      try {
        if (!(await processReferencesDir(entry, dirPath, dirName))) return;
        const cmdline = await fs.readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '');
        process.stderr.write(
          `# [qunitx] cleanup failed: pid ${entry} still references ${dirPath}` +
            ` (cmdline: ${cmdline.replace(/\0/g, ' ').slice(0, 120)})\n`,
        );
      } catch {
        /* vanished */
      }
    }),
  );
}
