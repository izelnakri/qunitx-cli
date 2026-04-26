// Factory-style esbuild plugin: invoked with the options tuple from package.json#qunitx.plugins.
// Produces a `virtual:greeting` module whose exported value reflects the user-supplied option,
// which proves three things about the loader: (1) the file is dynamic-imported from the user's
// project root, (2) the export is recognized as a factory, and (3) options are forwarded.
export default function virtualGreeting({ greeting } = {}) {
  return {
    name: 'virtual-greeting',
    setup(build) {
      build.onResolve({ filter: /^virtual:greeting$/ }, (args) => ({
        path: args.path,
        namespace: 'virtual-greeting',
      }));
      build.onLoad({ filter: /.*/, namespace: 'virtual-greeting' }, () => ({
        contents: `export const GREETING = ${JSON.stringify(greeting ?? 'fallback')};`,
        loader: 'js',
      }));
    },
  };
}
