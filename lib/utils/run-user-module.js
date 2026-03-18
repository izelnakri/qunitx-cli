import { red } from './color.js';

/**
 * Dynamically imports `modulePath` and calls its default export with `params`; exits with code 1 on error.
 * @returns {Promise<void>}
 */
export default async function runUserModule(modulePath, params, scriptPosition) {
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

    return process.exit(1);
  }
}
