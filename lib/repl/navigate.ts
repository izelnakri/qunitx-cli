// Winsock's WSAENOBUFS, which Chrome reports as ERR_NO_BUFFER_SPACE: the machine ran out of socket
// buffers for a moment — a loaded Windows runner with hundreds of sockets in TIME_WAIT. A "try
// again", not a refusal, and the session has this one load to get right or it never starts.
const NO_BUFFER_SPACE = 'net::ERR_NO_BUFFER_SPACE';
const ATTEMPTS = 5;
const BACKOFF_MS = 250;

/**
 * Opens the session's page, going again when the OS was briefly out of socket buffers.
 *
 * Every other failure is the caller's on the first attempt: a refused connection or a crashed
 * page is not something waiting fixes, and retrying it would only delay the error that says so.
 *
 * ```ts
 * import { navigate } from './navigate.ts';
 *
 * let calls = 0;
 * const page = {
 *   goto: async () => {
 *     if (++calls === 1) throw new Error('page.goto: net::ERR_NO_BUFFER_SPACE at http://localhost:1234/');
 *     return null;
 *   },
 * };
 *
 * await navigate(page, 'http://localhost:1234/', { backoffMs: 0 });
 * calls; // 2 — the second attempt got through
 * ```
 */
export async function navigate(
  page: { goto(url: string): Promise<unknown> },
  url: string,
  { backoffMs = BACKOFF_MS }: { backoffMs?: number } = {},
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url);
      return;
    } catch (error) {
      const outOfBuffers = String((error as Error)?.message).includes(NO_BUFFER_SPACE);
      if (!outOfBuffers || attempt === ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
    }
  }
}
