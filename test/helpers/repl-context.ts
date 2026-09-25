import process from 'node:process';
import * as Http from '../../lib/repl/http-service.ts';
import type { HttpService } from '../../lib/repl/http-service.ts';
import type { ReplContext } from '../../lib/commands/repl/command.ts';

/**
 * A {@link ReplContext} for running a command with no terminal and no browser.
 *
 * A command's `main` takes a context and its argument, which is the whole reason the interface
 * exists — so a test hands it one rather than standing up a pty and a Chrome. What it gives back
 * is the context and the lines that were printed to it, because "what did it say" is what nearly
 * every command test is asking.
 *
 * `page` is what {@link ReplSession.url} would be: the origin a path resolves against. `evaluate`
 * is the other half of the page the HTTP commands read — what an expression is worth — and it is
 * wrapped here exactly as the real session wraps it, so a test drives the same rule the browser
 * does. Left out, the context has no page to ask, which is its own case worth testing.
 *
 * ```ts
 * const it = replContext();
 * it.printed.length; // 0 — until a command says something
 * ```
 */
export function replContext(
  options: { cwd?: string; page?: string | null; evaluate?: (expression: string) => unknown } = {},
): {
  repl: ReplContext;
  printed: string[];
  http: HttpService;
} {
  const printed: string[] = [];
  const http = Http.create();
  const repl = {
    cwd: options.cwd ?? process.cwd(),
    // Unstyled, so an assertion compares words rather than escape sequences. The tests that are
    // ABOUT colour build their own painting theme.
    palette: { painter: () => (text: string) => text },
    http,
    session: {
      url: options.page === undefined ? 'http://localhost:4321/index.html' : options.page,
      ...(options.evaluate ? { toJSON: jsonThrough(options.evaluate) } : {}),
    },
    interactive: false,
    width: 80,
    log: (text: string) => void printed.push(text),
    // `write` keeps its bytes exactly, so a test can tell a block that ends in a newline from a
    // line the terminal added one to.
    write: (text: string) => void printed.push(text),
  } as unknown as ReplContext;

  return { repl, printed, http };
}

/** Everything a command printed, as one string — what a person would have seen on the screen. */
export function saidAll(printed: readonly string[]): string {
  return printed.join('\n');
}

/** `ReplSession.json`, over a plain evaluator: the value as JSON, or `null` where there is none. */
function jsonThrough(
  evaluate: (expression: string) => unknown,
): (expression: string) => Promise<string | null> {
  return (expression: string) => {
    try {
      const value = evaluate(expression);

      return Promise.resolve(value === undefined ? null : (JSON.stringify(value) ?? null));
    } catch {
      return Promise.resolve(null);
    }
  };
}
