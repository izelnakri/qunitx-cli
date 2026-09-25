import { spawn as spawnProcess } from 'node:child_process';
import { writeHost } from './host.ts';
import type { ChildProcess } from 'node:child_process';

// Starting a runtime with its inspector open, and finding out where the inspector is. The same
// shape as `lib/chrome/spawn.ts`, and for the same reason: the port is chosen by the child and
// announced on stderr, so the only way to learn it is to read what the child said.

/** Which runtime a prompt is being opened on. `chromium` is the other one, and lives elsewhere. */
export type RuntimeName = 'node' | 'deno';

/** A runtime that is up, stopped before its first statement, and waiting to be told to go. */
export interface InspectedRuntime {
  /** The child, kept so a prompt can tell whether it is still there. */
  process: ChildProcess;
  /** `ws://127.0.0.1:<port>/<uuid>` — the CDP socket. */
  inspectorURL: string;
  /** The inspector's HTTP port, which also serves `/json/list`. */
  port: string;
  /** Ends it. Safe to call twice; the second does nothing. */
  shutdown(): Promise<void>;
}

// What node and deno each print once the inspector is listening. Both spell it `ws://`, and both
// print it before any user code runs, which is the whole point of the -brk form.
const INSPECTOR_URL = /(ws:\/\/[^\s]+)/;
// Long enough for a cold `deno run` on a loaded machine, short enough that a runtime which will
// never announce itself is a message rather than a hang.
const ANNOUNCE_TIMEOUT_MS = 15_000;

/**
 * Starts `node` or `deno` stopped at its first line, with the qunitx host module loaded.
 *
 * `--inspect-brk` rather than `--inspect`, deliberately: the prompt has to be attached BEFORE any
 * of your code runs, or a breakpoint in a file the host imports can only be set after the import
 * has already gone past it. What comes back is a runtime that has not executed anything yet —
 * `lib/repl/inspector-realm.ts` is what lets it go.
 *
 * Deno is given `-A`. A prompt you opened on your own project to import your own files is not a
 * sandbox, and a permission prompt fired at a runtime with no terminal of its own would hang with
 * nothing on screen to explain why.
 *
 * ```ts
 * import { spawn } from './spawn.ts';
 *
 * // Defined, not invoked: it starts a process.
 * async function example(cwd: string) {
 *   const runtime = await spawn('node', cwd);
 *   await runtime.shutdown();
 *
 *   return runtime.inspectorURL.startsWith('ws://'); // true
 * }
 * ```
 */
export async function spawn(runtime: RuntimeName, cwd: string): Promise<InspectedRuntime> {
  const host = await writeHost(cwd);
  const argv =
    runtime === 'node'
      ? ['--inspect-brk=0', host]
      : ['run', '-A', '--inspect-brk=127.0.0.1:0', host];
  // `stdout` is inherited on purpose: `console.log` from your own code reaches the inspector as
  // `Runtime.consoleAPICalled` AND the child's stdout, and the prompt prints the first. Piping the
  // second without draining it would fill a pipe buffer and wedge the runtime mid-log.
  const child = spawnProcess(runtime, argv, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });

  let ended = false;
  const shutdown = async (): Promise<void> => {
    if (ended) return;
    ended = true;
    child.kill('SIGKILL');
    await new Promise<void>((done) =>
      child.exitCode === null ? child.once('exit', () => done()) : done(),
    );
  };

  try {
    const inspectorURL = await announced(child);

    return { process: child, inspectorURL, port: new URL(inspectorURL).port, shutdown };
  } catch (error) {
    await shutdown();
    throw error;
  }
}

/** The `ws://` line the runtime prints once its inspector is listening, or why it never came. */
function announced(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let said = '';
    const timer = setTimeout(() => {
      reject(
        new Error(
          `the runtime never said where its inspector was${said === '' ? '' : `:\n${said}`}`,
        ),
      );
    }, ANNOUNCE_TIMEOUT_MS);
    // Unref'd: this timer must not be the reason a prompt that is otherwise done stays open.
    timer.unref?.();

    const settle = (outcome: () => void) => {
      clearTimeout(timer);
      outcome();
    };
    child.stderr?.on('data', (chunk: Buffer) => {
      said += String(chunk);
      const found = INSPECTOR_URL.exec(said);
      if (found) settle(() => resolve(found[1]!));
    });
    // A runtime that is not installed fails here rather than at the timeout, which is the
    // difference between a sentence and a fifteen-second pause.
    child.once('error', (error: Error) => settle(() => reject(error)));
    child.once('exit', (code) =>
      settle(() =>
        reject(new Error(`the runtime exited with ${code} before it opened an inspector\n${said}`)),
      ),
    );
  });
}
