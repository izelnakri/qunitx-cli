import { WebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import type { RawData } from 'ws';

/** A running bridge: the port a frontend may connect to, and how to take it down. */
export interface Bridge {
  /** Where the DevTools frontend should point its `ws=` — `localhost:<port>`. */
  address: string;
  /** Drops every frontend still attached and stops listening. */
  close(): Promise<void>;
}

/**
 * A WebSocket the DevTools frontend is allowed to open, piped to the one Chrome will accept.
 *
 * Chrome answers **403** to a debugger connection carrying an `Origin` header — which a browser
 * always sends — unless it was started with `--remote-allow-origins`. The value that flag would
 * need is the port Chrome chose for itself, which is not known until after it has started, so the
 * only spelling available at launch is `*`: every origin, including any page that happens to be
 * open in your own browser. That is precisely the hole the check exists to close.
 *
 * Node sends no `Origin`. So the frontend connects here, and this connects onward from Node, and
 * Chrome's protection is left exactly as it was. Nothing is listening until somebody asks for
 * DevTools, and it listens on the loopback interface only.
 *
 * ```ts
 * import { bridgeTo } from './devtools.ts';
 *
 * // Defined, not invoked: it binds a port and talks to a real browser.
 * async function example() {
 *   const bridge = await bridgeTo('ws://127.0.0.1:9222/devtools/page/ABC');
 *   return bridge.address; // 'localhost:41234' — what a frontend's `ws=` should say
 * }
 * ```
 */
export async function bridgeTo(upstream: string): Promise<Bridge> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((listening) => server.once('listening', listening));

  server.on('connection', (client) => {
    const chrome = new WebSocket(upstream);
    // A frontend starts talking the moment its socket opens, which is before the socket to Chrome
    // has finished opening. Held rather than dropped: the first message is the one that asks what
    // the page is, and a DevTools that never gets an answer to it shows an empty window.
    const waiting: Array<{ data: RawData; binary: boolean }> = [];
    const bothWays = () => {
      client.close();
      chrome.close();
    };

    chrome.on('open', () => {
      for (const held of waiting) chrome.send(held.data as Buffer, { binary: held.binary });
      waiting.length = 0;
    });
    client.on('message', (data, binary) => {
      if (chrome.readyState === WebSocket.OPEN) chrome.send(data as Buffer, { binary });
      else waiting.push({ data, binary });
    });
    chrome.on('message', (data, binary) => client.send(data as Buffer, { binary }));
    for (const socket of [client, chrome]) {
      socket.on('close', bothWays);
      socket.on('error', bothWays);
    }
  });

  return {
    address: `localhost:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise((closed) => {
        for (const client of server.clients) client.terminate();
        server.close(() => closed());
      }),
  };
}
