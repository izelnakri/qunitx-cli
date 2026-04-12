import { red } from './color.ts';

/**
 * Dynamically imports `modulePath` and calls its default export with `params`; exits with code 1 on error.
 * @returns {Promise<void>}
 */
export async function runUserModule(
  modulePath: string,
  params: unknown,
  scriptPosition: string,
): Promise<void> {
  try {
    const func = await import(modulePath);
    if (func) {
      func.default
        ? await func.default(params)
        : typeof func === 'function'
          ? await func(params)
          : null;
    }
  } catch (error) {
    console.log('#', red(`QUnitX ${scriptPosition} script failed:`));
    console.trace(error);
    console.error(error);

    // Flush stdout before exiting — in piped contexts stdout is buffered and
    // process.exit() can drop pending writes before they reach the OS.
    process.stdout.write('', () => process.exit(1));
  }
}

export { runUserModule as default };
