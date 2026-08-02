import process from 'node:process';

// Process-wide globals, lent for the duration of a scope and given back on the way out.
//
// The daemon is the reason this exists: it serves many clients from one process, and each run
// needs `process.argv` and `process.env` to look like that client's invocation. Clobbering a
// global you must put back is a resource, so these hand back a `Disposable` and let the language
// do the putting back:
//
//   using _argv = borrowArgv(['node', 'cli.ts', ...clientArgv]);
//   const config = await Config.setup().result();   // restored on return, throw, or early return
//
// A `try`/`finally` says the same thing, but it says it at the call site — which is where two
// snapshots taken together and only one restored is an easy thing to write and a very hard thing
// to see. Disposal runs in reverse order of acquisition, so nested borrows unwind like a stack.

/**
 * Replaces `process.argv` for the scope and restores the previous value on exit.
 *
 * ```ts
 * import { borrowArgv } from './borrowed-globals.ts';
 *
 * const before = process.argv;
 * {
 *   using _argv = borrowArgv(['node', 'cli.ts', '--watch']);
 *   process.argv[2]; // '--watch'
 * }
 * process.argv === before; // true — restored at the closing brace
 * ```
 */
export function borrowArgv(argv: string[]): Disposable {
  const previous = process.argv;
  process.argv = argv;

  return {
    [Symbol.dispose]() {
      process.argv = previous;
    },
  };
}

/**
 * Applies `overrides` over `process.env` for the scope, then restores it exactly: keys added
 * during the scope are dropped and changed values are put back.
 *
 * Key-by-key rather than `process.env = snapshot`, because assigning the object wholesale
 * replaces the live binding other modules may already hold a reference to.
 *
 * ```ts
 * import { borrowEnv } from './borrowed-globals.ts';
 *
 * {
 *   using _env = borrowEnv({ QUNITX_BORROW_EXAMPLE: '1' });
 *   process.env.QUNITX_BORROW_EXAMPLE; // '1'
 * }
 * process.env.QUNITX_BORROW_EXAMPLE; // undefined — the key never existed, so it is dropped
 * ```
 */
export function borrowEnv(overrides: Record<string, string | undefined>): Disposable {
  const snapshot = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) process.env[key] = value;
  }

  return {
    [Symbol.dispose]() {
      for (const key of Object.keys(process.env)) {
        if (!(key in snapshot)) delete process.env[key];
      }
      Object.assign(process.env, snapshot);
    },
  };
}
