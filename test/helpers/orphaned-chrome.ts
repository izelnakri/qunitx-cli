import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { killProcessGroup } from '../../lib/utils/kill-process-group.ts';
import * as Chrome from '../../lib/chrome/index.ts';

/**
 * One running process, as much of it as deciding ownership needs.
 *
 * ```ts
 * const chrome: ProcessEntry = { pid: 20, ppid: 10, pgid: 20, name: 'chrome', command: 'chrome --user-data-dir=/tmp/qunitx-chrome-a' };
 * ```
 */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  /** Its process group, where the platform has them. */
  pgid: number | null;
  /** The executable's short name, lower case, without `.exe`. */
  name: string;
  command: string;
}

// What owns a qunitx Chrome: the node, deno or compiled qunitx process that launched it.
const OWNER = /^(node|deno|qunitx|mainthread)/;

/**
 * Which qunitx Chromes to kill and which profiles to keep. A process that names a
 * `qunitx-chrome-*` profile is owned while its parent chain still reaches a node, deno or qunitx
 * process; one whose chain ends first (reparented to init or a subreaper) is an orphan. A profile
 * any owned process uses is live, whoever's run it belongs to: another runner, or a `qunitx` in a
 * terminal.
 *
 * ```ts
 * import { planSweep } from './orphaned-chrome.ts';
 *
 * const plan = planSweep(
 *   [
 *     { pid: 10, ppid: 1, pgid: 10, name: 'node', command: 'node cli.ts' },
 *     { pid: 20, ppid: 10, pgid: 20, name: 'chrome', command: 'chrome --user-data-dir=/tmp/qunitx-chrome-a' },
 *     { pid: 30, ppid: 1, pgid: 30, name: 'chrome', command: 'chrome --user-data-dir=/tmp/qunitx-chrome-b' },
 *   ],
 *   ['qunitx-chrome-a', 'qunitx-chrome-b'],
 * );
 * plan.orphans.map((entry) => entry.pid); // [30]
 * [...plan.liveDirs]; // ['qunitx-chrome-a']
 * ```
 */
export function planSweep(
  processes: ProcessEntry[],
  chromeDirs: string[],
): { orphans: ProcessEntry[]; liveDirs: Set<string> } {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const owned = (entry: ProcessEntry): boolean => {
    const seen = new Set<number>();
    for (let parent = byPid.get(entry.ppid); parent; parent = byPid.get(parent.ppid)) {
      if (OWNER.test(parent.name)) return true;
      if (seen.has(parent.pid) || parent.pid <= 1) return false;
      seen.add(parent.pid);
    }
    return false;
  };
  const orphans: ProcessEntry[] = [];
  const liveDirs = new Set<string>();
  for (const entry of processes) {
    const dirs = chromeDirs.filter((dir) => entry.command.includes(dir));
    if (!dirs.length) continue;
    if (owned(entry)) dirs.forEach((dir) => liveDirs.add(dir));
    else orphans.push(entry);
  }
  return { orphans, liveDirs };
}

/**
 * Kills the qunitx Chromes nobody owns any more — left behind by a CLI that was SIGKILLed — and
 * removes the profiles no live process uses. Never touches a Chrome some run still owns.
 *
 * ```ts
 * import { sweepOrphanedChrome } from './orphaned-chrome.ts';
 *
 * // Defined, not invoked: kills processes.
 * async function betweenPhases() {
 *   await sweepOrphanedChrome();
 * }
 * ```
 */
export async function sweepOrphanedChrome(): Promise<void> {
  try {
    const tmpDir = os.tmpdir();
    const chromeDirs = (await fs.readdir(tmpDir)).filter((entry) =>
      entry.startsWith('qunitx-chrome-'),
    );
    if (chromeDirs.length === 0) return;
    const { orphans, liveDirs } = planSweep(await processes(), chromeDirs);
    for (const orphan of orphans) {
      if (process.platform === 'win32') {
        await promisify(execFile)('taskkill', ['/F', '/T', '/PID', String(orphan.pid)]).catch(
          () => {},
        );
      } else if (orphan.pgid === orphan.pid) {
        // Its own group (Chrome is spawned detached): the renderers go with it.
        killProcessGroup(orphan.pid);
      } else {
        try {
          process.kill(orphan.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
    // cleanupDir retries rm() until it succeeds, so a profile whose orphan is still dying is
    // removed once it lets go; a live one is not ours to remove.
    await Promise.all(
      chromeDirs
        .filter((dir) => !liveDirs.has(dir))
        .map((dir) => Chrome.cleanupDir(path.join(tmpDir, dir))),
    );
  } catch {
    /* best effort — never block suite exit */
  }
}

// Every process on the machine, from /proc, ps, or CIM.
async function processes(): Promise<ProcessEntry[]> {
  if (process.platform === 'linux') {
    const entries = await Promise.all(
      (await fs.readdir('/proc'))
        .filter((entry) => /^\d+$/.test(entry))
        .map(async (entry) => {
          try {
            const [stat, command] = await Promise.all([
              fs.readFile(`/proc/${entry}/stat`, 'utf8'),
              fs.readFile(`/proc/${entry}/cmdline`, 'utf8'),
            ]);
            // `pid (comm) state ppid pgrp …`; comm may itself contain spaces or parentheses.
            const name = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')).toLowerCase();
            const [, ppid, pgid] = stat
              .slice(stat.lastIndexOf(')') + 2)
              .split(' ')
              .map(Number);
            return { pid: Number(entry), ppid, pgid, name, command: command.replaceAll('\0', ' ') };
          } catch {
            return null; // gone mid-scan
          }
        }),
    );
    return entries.filter((entry) => entry !== null);
  } else if (process.platform === 'win32') {
    const { stdout } = await promisify(execFile)(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return (
      JSON.parse(stdout) as {
        ProcessId: number;
        ParentProcessId: number;
        Name: string | null;
        CommandLine: string | null;
      }[]
    ).map((entry) => ({
      pid: entry.ProcessId,
      ppid: entry.ParentProcessId,
      pgid: null,
      name: (entry.Name ?? '').toLowerCase().replace(/\.exe$/, ''),
      command: entry.CommandLine ?? '',
    }));
  }
  const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,pgid=,comm=,command='], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter((match) => match !== null)
    .map(([, pid, ppid, pgid, comm, command]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      name: path.basename(comm).toLowerCase(),
      command,
    }));
}
