import { WebSocket } from 'ws';

// A CDP client, in the small. playwright brings one of these, but it brings a browser with it —
// and a `node --inspect` socket is the same protocol with no browser anywhere near it. So: an id
// counter, a map of what is outstanding, and a demultiplexer. `ws` is already a dependency.

/** What a caller does with an inspector socket. The shape `lib/repl/realm.ts` asks for, minus the runtime. */
export interface InspectorClient {
  /** One CDP call. Rejects with whatever the protocol said was wrong, never with a timeout. */
  send<T = void>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Every message the far side volunteers under this method name. */
  on(event: string, handler: (params: never) => void): void;
  /** Stops listening. The runtime on the other end is somebody else's to end. */
  close(): void;
}

/**
 * Connects to a `--inspect` socket and speaks CDP over it.
 *
 * Deliberately WITHOUT a timeout on `send`, which looks like an omission and is the opposite:
 * `Runtime.evaluate` does not answer while the runtime is stopped at a breakpoint, and a prompt
 * that gave up on it after some number of seconds would turn every pause into a lie. The session
 * races the evaluation against the pause event instead — see `Session.#eval`.
 *
 * ```ts
 * import { connect } from './client.ts';
 *
 * // Defined, not invoked: it opens a socket.
 * async function example(url: string) {
 *   const client = await connect(url);
 *   await client.send('Runtime.enable');
 *
 *   return await client.send<{ result: { value?: unknown } }>('Runtime.evaluate', {
 *     expression: '1 + 1',
 *     returnByValue: true,
 *   });
 * }
 * ```
 */
export function connect(url: string): Promise<InspectorClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map<
      number,
      { settle: (value: never) => void; fail: (why: Error) => void }
    >();
    const listeners = new Map<string, Array<(params: never) => void>>();
    let lastId = 0;

    socket.on('message', (raw: Buffer | string) => {
      const message = JSON.parse(String(raw)) as {
        id?: number;
        method?: string;
        params?: never;
        result?: never;
        error?: { message?: string };
      };
      if (message.id === undefined) {
        // An event nobody asked about is the normal case — a runtime narrates far more than a
        // prompt reads — so an empty list is not worth a warning.
        for (const listener of listeners.get(message.method ?? '') ?? []) listener(message.params!);

        return;
      }
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiting?.fail(new Error(message.error.message ?? 'the inspector refused'));
      else waiting?.settle(message.result!);
    });

    // A socket that dies with calls outstanding would otherwise hang each of them forever, and the
    // prompt with them: a runtime that exits mid-evaluation is a thing that happens.
    const abandon = (why: Error) => {
      for (const waiting of pending.values()) waiting.fail(why);
      pending.clear();
    };
    socket.on('close', () => abandon(new Error('the runtime went away')));
    socket.on('error', (error: Error) => {
      abandon(error);
      reject(error);
    });

    socket.on('open', () =>
      resolve({
        send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
          if (socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error('the runtime went away'));
          }

          return new Promise<T>((settle, fail) => {
            const id = ++lastId;
            pending.set(id, {
              settle: settle as (value: never) => void,
              fail,
            });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        on(event: string, handler: (params: never) => void): void {
          const already = listeners.get(event);
          if (already) already.push(handler);
          else listeners.set(event, [handler]);
        },
        close(): void {
          socket.close();
        },
      }),
    );
  });
}
