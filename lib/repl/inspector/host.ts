import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * The first and only code qunitx runs inside the runtime it is about to hand you.
 *
 * It exists for one reason, and the reason is not obvious until you have lost an afternoon to it:
 * `import()` inside `Runtime.evaluate` FAILS. The inspector evaluates in a context with no module
 * resolution callback attached, so node answers `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` and deno
 * answers `TypeError: Import "x" not a dependency` — for `node:os`, for a relative path, for
 * everything. A prompt that cannot import is not a prompt.
 *
 * A module's own `import()` carries that callback. So the runtime starts on a real module, that
 * module puts its `import` in a global, and every later load goes through the bridge. Which is
 * also why this is a FILE rather than a string evaluated over the wire: it has to be a module, and
 * it has to sit where the project's own resolution can see it, or `import('qunitx')` and every
 * other bare specifier resolves against the wrong place.
 *
 * The interval is the other half. A runtime whose event loop drains exits, and this one has
 * nothing to do between two things you type — `--inspect` alone does not hold a process open.
 */
const HOST_SOURCE = `// Written by qunitx. The prompt on the other end of --inspect needs three things from here.
// A module's import() carries a resolution callback; Runtime.evaluate's context does not. Every
// load the prompt makes goes through this one, which is why it is the first thing installed.
globalThis.__qunitxImport = (specifier) => import(specifier);

// The same bridge for code that has no file: a data: URL is a module specifier, so a bundle built
// at the prompt can be imported without ever being written down.
globalThis.__qunitxImportSource = (source) =>
  import('data:text/javascript;charset=utf-8,' + encodeURIComponent(source));

// \`qunitx\` ships a build per runtime, and the node and deno ones register tests with node:test
// and Deno.test — runners that own the process and hand out no queue a prompt could flush on
// demand. The BROWSER build is the one whose QUnit has that queue, and it needs no DOM to run:
// same version, same assertions, same pass/fail. Resolved through the package rather than guessed
// at, and falling back to this runtime's own build, where a prompt still works for everything
// except running tests at it.
globalThis.__qunitxRuntimeModule = async () => {
  const own = import.meta.resolve('qunitx');
  const browser = own
    .replace('/dist/node/index.js', '/dist/browser/index.js')
    .replace('/dist/deno/index.js', '/dist/browser/index.js');
  if (browser === own) return await import(own);
  try {
    return await import(browser);
  } catch {
    return await import(own);
  }
};

// A runtime with an empty event loop exits, and between two typed lines this one has nothing to
// do. Unref'd would defeat the point; this is the handle that makes the process wait for you.
globalThis.__qunitxAlive = setInterval(() => {}, 1 << 30);
`;

// Where this package already keeps its V8 compile cache: ignored by git, and outside the sweep
// the leak tests do over `os.tmpdir()`.
const HOST_DIRECTORY = path.join('node_modules', '.cache', 'qunitx');

/**
 * Writes the host module into the project and says where it landed.
 *
 * Inside the project on purpose: a module resolves bare specifiers from where IT is, so a host in
 * a temp directory can import `node:os` and nothing else — not `qunitx`, not the project's own
 * dependencies, not the test file you opened the prompt to poke at. `node_modules/.cache/qunitx`
 * is where this package already keeps its V8 compile cache, which means it is already ignored, and
 * already outside the sweep the leak tests do over `os.tmpdir()`.
 *
 * `.mjs` rather than `.js` because a project without `"type": "module"` would otherwise be handed
 * a module as CommonJS, and rather than `.ts` because nothing here needs stripping and a generated
 * artifact should not depend on which runtimes can strip.
 *
 * ```ts
 * import { writeHost } from './host.ts';
 *
 * // Defined, not invoked: it writes into the project.
 * async function example(cwd: string) {
 *   const host = await writeHost(cwd);
 *
 *   return host.endsWith('repl-host.mjs'); // true
 * }
 * ```
 */
export async function writeHost(cwd: string): Promise<string> {
  const directory = path.join(cwd, HOST_DIRECTORY);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'repl-host.mjs');
  await fs.writeFile(file, HOST_SOURCE);

  return file;
}
