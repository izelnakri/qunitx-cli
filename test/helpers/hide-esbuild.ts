// `node --import ./test/helpers/hide-esbuild.ts cli.ts …` runs the CLI as if esbuild had never been
// installed: every `import('esbuild')` fails the way a missing package does. The only honest way
// to test the no-esbuild path on a machine that has esbuild — uninstalling it would break every
// other test running alongside.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'esbuild') {
      throw Object.assign(new Error("Cannot find package 'esbuild'"), {
        code: 'ERR_MODULE_NOT_FOUND',
      });
    }
    return nextResolve(specifier, context);
  },
});
