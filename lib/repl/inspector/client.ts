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
  /** Stops delivering to one handler — the same function object that was passed to `on`. */
  off(event: string, handler: (params: never) => void): void;
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
      // Both guards below are about the same thing: this runs inside a `ws` event handler, and an
      // exception thrown in one of those leaves the emitter, becomes an `uncaughtException`, and
      // takes the whole prompt with it. A frame that is not JSON — a binary frame, half a message
      // from a runtime being killed mid-write — is worth dropping, not dying for.
      let message: {
        id?: number;
        method?: string;
        params?: never;
        result?: never;
        error?: { message?: string };
      };
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (message.id === undefined) {
        // An event nobody asked about is the normal case — a runtime narrates far more than a
        // prompt reads — so an empty list is not worth a warning. Each listener is called inside
        // its own try: one that throws must not stop the ones registered after it, which is how a
        // single odd console argument used to cost a `Debugger.paused`.
        for (const listener of [...(listeners.get(message.method ?? '') ?? [])]) {
          try {
            listener(message.params!);
          } catch {
            /* the listener's problem, not the transport's */
          }
        }

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
    // `reject` as well as `abandon`: a socket that closes before it ever opened — the inspector
    // refusing a second debugger, a port that went away — would otherwise leave `connect()`
    // pending forever, and the prompt waiting on it with nothing to print.
    socket.on('close', () => {
      const why = new Error('the runtime went away');
      abandon(why);
      reject(why);
    });
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
            pending.set(id, { settle: settle as (value: never) => void, fail });
            try {
              socket.send(JSON.stringify({ id, method, params }));
            } catch (error) {
              // A socket that went from OPEN to CLOSING between the check above and here throws
              // here, and the entry would otherwise sit in `pending` unsettled forever.
              pending.delete(id);
              fail(error as Error);
            }
          });
        },
        on(event: string, handler: (params: never) => void): void {
          const already = listeners.get(event);
          if (already) already.push(handler);
          else listeners.set(event, [handler]);
        },
        off(event: string, handler: (params: never) => void): void {
          const already = listeners.get(event);
          if (!already) return;
          const at = already.indexOf(handler);
          if (at !== -1) already.splice(at, 1);
        },
        close(): void {
          socket.close();
        },
      }),
    );
  });
}
