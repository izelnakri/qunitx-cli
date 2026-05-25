import { module, test } from 'qunitx';
import { spawn } from 'node:child_process';
import { killProcessGroup } from '../../lib/utils/kill-process-group.ts';

module('Utils | killProcessGroup', { concurrency: true }, () => {
  // POSIX-only tests use `sh -c` rather than process.execPath so they're
  // runtime-agnostic. Under the Deno-driven test runner, process.execPath is
  // the deno binary, which doesn't accept node's `-e` / `--input-type=module`
  // / `--eval` flags. The behavior under test (killProcessGroup) is a wrapper
  // over `process.kill(-pid)` — what the child process actually runs is
  // irrelevant, so a 60-second `sleep` from /bin/sh is the simplest stand-in.

  test(
    'kills the spawned process when it has no children',
    { skip: process.platform === 'win32' },
    async (assert) => {
      const proc = spawn('sh', ['-c', 'sleep 60'], { detached: true, stdio: 'ignore' });
      proc.unref();
      const pid = proc.pid!;

      assert.ok(isAlive(pid), 'process is alive before kill');

      killProcessGroup(pid);

      const gone = await pollUntil(() => !isAlive(pid));
      assert.ok(gone, 'process is gone after killProcessGroup');
    },
  );

  test(
    'kills the entire process group — parent and its children share the same PGID',
    { skip: process.platform === 'win32' },
    async (assert) => {
      // Parent shell backgrounds a `sleep 60` (the grandchild), prints its PID
      // via $!, then `wait`s to stay alive. detached:true makes the shell a
      // group leader, so the backgrounded sleep inherits its PGID — the
      // condition killProcessGroup is supposed to handle.
      const parent = spawn('sh', ['-c', 'sleep 60 & echo $!; wait'], {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      const grandchildPid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for grandchild PID')),
          5000,
        );
        let buf = '';
        parent.stdout!.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          const line = buf.trim();
          if (line) {
            clearTimeout(timer);
            resolve(parseInt(line, 10));
          }
        });
      });

      assert.ok(grandchildPid > 0, `grandchild spawned with PID ${grandchildPid}`);
      assert.ok(isAlive(parent.pid!), 'parent is alive before kill');
      assert.ok(isAlive(grandchildPid), 'grandchild is alive before kill');

      killProcessGroup(parent.pid!);

      // Wait for parent to fully exit (signals the group kill landed).
      await new Promise<void>((r) => parent.once('close', r));

      // Grandchild may briefly linger until init reaps it — poll rather than
      // checking synchronously to avoid a false failure on a slow CI runner.
      const grandchildGone = await pollUntil(() => !isAlive(grandchildPid));
      assert.ok(grandchildGone, 'grandchild is also killed as part of the process group');
    },
  );
});

// Polls `check()` every 20 ms until it returns true or `deadlineMs` elapses.
// Used to wait for OS process-table cleanup after SIGKILL — the kernel delivers
// SIGKILL immediately but the entry lingers until the parent calls wait().
async function pollUntil(check: () => boolean, deadlineMs = 1000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return check();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check; throws ESRCH if gone
    return true;
  } catch {
    return false;
  }
}
