import fs from 'node:fs/promises';

const CLEANUP_DEADLINE_MS = 5_000;
const CLEANUP_RETRY_MS = 50;

/**
 * Kills all surviving processes that reference `dirPath` (checked via cwd, cmdline,
 * and open file descriptors), then retries fs.rm() until it succeeds or a 5-second
 * deadline expires. Re-scans /proc on each failed rm() attempt to catch processes
 * that appear after the initial scan (e.g. late-forked Chrome helpers).
 *
 * Deliberately does NOT wait for killed processes to fully leave the process table
 * (no killAndAwait). kill(pid, 0) succeeds for zombie processes (FDs already released)
 * and for D-state processes (SIGKILL queued but not yet delivered), so polling it can
 * stall indefinitely on a loaded CI machine while rm() could already succeed. Instead,
 * rm() itself is the authoritative check: it fails while FDs are held and succeeds
 * once they are released, regardless of how far the process-table cleanup has progressed.
 *
 * Linux-only: falls back to a single best-effort rm() on other platforms.
 */
export async function cleanupBrowserDir(dirPath: string): Promise<void> {
  if (process.platform !== 'linux') {
    await fs.rm(dirPath, { recursive: true, force: true }).catch(() => {});
    return;
  }

  const dirName = dirPath.split('/').pop()!;

  // Phase 1: initial kill sweep — send SIGKILL to every process referencing the dir.
  await killAllReferencingProcesses(dirPath, dirName);

  // Phase 2: retry rm() until success or 5s deadline.
  // Re-scan /proc on each failure — new Chrome helper processes may appear after the
  // initial kill pass (late-forked GPU helpers, zygote children, etc.).
  // Each loop body is bounded (rm + /proc scan + 50ms sleep), so the deadline is
  // always respected and we never stall waiting for process-table cleanup.
  const deadline = Date.now() + CLEANUP_DEADLINE_MS;
  while (Date.now() < deadline) {
    // Verify with fs.access after rm: on overlayfs (Docker CI) the VFS cache can report
    // the directory as gone to rm() while still returning it in readdir() to other processes.
    // Treating rm-success + access-still-exists as a soft failure keeps the retry loop alive
    // until the cache flushes or all FD holders are fully gone.
    const removed = await fs
      .rm(dirPath, { recursive: true, force: true })
      .then(() =>
        fs.access(dirPath).then(
          () => false,
          () => true,
        ),
      )
      .catch(() => false);
    if (removed) return;
    await killAllReferencingProcesses(dirPath, dirName);
    await new Promise<void>((resolve) => setTimeout(resolve, CLEANUP_RETRY_MS));
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

// Scans /proc and SIGKILLs every process that references dirPath via cwd, cmdline, or open FDs.
async function killAllReferencingProcesses(dirPath: string, dirName: string): Promise<void> {
  const procEntries = await fs.readdir('/proc').catch(() => [] as string[]);
  await Promise.all(
    procEntries.map(async (entry) => {
      if (!/^\d+$/.test(entry)) return;
      if (!(await processReferencesDir(entry, dirPath, dirName))) return;
      try {
        process.kill(parseInt(entry), 'SIGKILL');
      } catch {
        /* ESRCH: already dead */
      }
    }),
  );
}
