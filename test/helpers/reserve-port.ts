import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

// A port for a test to hand to something else — a CLI child, or `bindServerToPort` — which is
// only safe if nobody else can take it in between. `listen(0)` then close does not give that: it
// comes from the OS's ephemeral range (32768+ on Linux, 49152+ on macOS and Windows), the pool
// every outgoing socket and every other worker's `listen(0)` draws from, so on a 16-worker suite a
// released one is regularly handed straight back out. That is how v0.37.0's Deno lane went red.
//
// These come from below every ephemeral range, and each is claimed with an atomic `mkdir` in a
// directory shared by the run's workers — unique across all of them without a coordinator.

/** Below Linux's ephemeral floor (32768) and far below macOS's and Windows' (49152). */
export const RESERVED_RANGE = { from: 20000, to: 29999 } as const;

/**
 * Where this run's claims live: one directory per run, named by the semaphore port the runner
 * hands every worker (so they all share it), or by pid when a test file is run on its own.
 */
const CLAIMS = path.join(
  'tmp',
  '.port-claims',
  process.env.QUNITX_SEMAPHORE_PORT ?? `pid-${process.pid}`,
);

/**
 * A port no other test in this run is handed, that the OS does not give out on its own, and that
 * nothing on the machine was listening on when it was chosen.
 *
 * ```ts
 * import { reservePort } from './reserve-port.ts';
 *
 * // Defined, not invoked: it binds a real port.
 * async function example() {
 *   const port = await reservePort(); // e.g. 24817
 *   return `node cli.ts test/ --port=${port}`;
 * }
 * ```
 */
export async function reservePort({
  range = RESERVED_RANGE,
  claims = CLAIMS,
}: { range?: { from: number; to: number }; claims?: string } = {}): Promise<number> {
  const size = range.to - range.from + 1;
  // A random start spreads concurrent callers apart, so they rarely contend for the same claim.
  const start = Math.floor(Math.random() * size);
  await fs.mkdir(claims, { recursive: true });

  for (let step = 0; step < size; step++) {
    const port = range.from + ((start + step) % size);
    if ((await claim(claims, port)) && (await isFree(port))) return port;
  }

  throw new Error(`no free port left in ${range.from}–${range.to} (claims in ${claims})`);
}

/** Whether this call is the first in the run to ask for `port` — `mkdir` is atomic everywhere. */
async function claim(claims: string, port: number): Promise<boolean> {
  try {
    await fs.mkdir(path.join(claims, String(port)));

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/** Bound the way the CLI binds (all interfaces), so a port it would refuse is refused here. */
function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true)));
  });
}
