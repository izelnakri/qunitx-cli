import path from 'node:path';
import * as SourceMap from './source-map.ts';
import { importEsbuild } from './import-esbuild.ts';
import type { SourceMapDecoder } from './source-map.ts';

// Per-file source transforms, for code that reaches a runtime without passing through a bundler:
// the modules a --no-bundle page loads, and line targeting's declaration scan when esbuild is not
// installed. TypeScript is type-stripped in-process by the runtime's own TypeScript support — no
// esbuild — while JSX has no built-in transform and needs esbuild after all.

const TYPESCRIPT = new Set(['.ts', '.mts', '.cts']);
const JSX = new Set(['.jsx', '.tsx']);

/**
 * True for an extension {@link transform} rewrites; anything else it returns unchanged.
 *
 * ```ts
 * import { isTransformed } from './transform-source.ts';
 *
 * isTransformed('.ts'); // true
 * isTransformed('.js'); // false
 * ```
 */
export function isTransformed(extension: string): boolean {
  return TYPESCRIPT.has(extension) || JSX.has(extension);
}

/**
 * Transforms one source file into what the browser runs. TypeScript is type-stripped, which keeps
 * every line and column where it was — so a stack frame needs no source map at all. Syntax that
 * stripping cannot erase (`enum`, `namespace`, parameter properties) falls back to a full
 * transform, with a source map. `.jsx`/`.tsx` go through esbuild's transform, one file at a time.
 *
 * ```ts
 * import { transform } from './transform-source.ts';
 *
 * // Defined, not invoked: the first strip loads the runtime's TypeScript support.
 * async function example() {
 *   const { code } = await transform('/proj/a.ts', 'const a: number = 1;');
 *   return code; // 'const a         = 1;'
 * }
 * ```
 */
export async function transform(
  absolutePath: string,
  source: string,
): Promise<{ code: string; map: SourceMapDecoder | null }> {
  const extension = path.extname(absolutePath);
  if (TYPESCRIPT.has(extension)) {
    const strip = await stripTypeScriptTypes();
    try {
      return { code: strip(source, { mode: 'strip' }), map: null };
    } catch (error) {
      if ((error as { code?: string }).code !== 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') throw error;
      const code = strip(source, { mode: 'transform', sourceMap: true, sourceUrl: absolutePath });
      return { code, map: moduleMap(code, absolutePath, source) };
    }
  }
  if (JSX.has(extension)) {
    const esbuild = await importEsbuild(`${extension} files in a --no-bundle run`);
    const { code } = await esbuild.transform(source, {
      loader: extension === '.tsx' ? 'tsx' : 'jsx',
      jsx: 'automatic',
      format: 'esm',
      sourcemap: 'inline',
      sourcefile: absolutePath,
    });
    return { code, map: moduleMap(code, absolutePath, source) };
  }

  return { code: source, map: null };
}

function moduleMap(code: string, absolutePath: string, source: string): SourceMapDecoder | null {
  const map = SourceMap.extractInline(code, path.dirname(absolutePath));
  if (!map) return null;
  // One file in, one file out: whatever the transform wrote as the source name, it is this file.
  return { ...map, sources: [absolutePath], sourcesContent: [source] };
}

// ── TypeScript stripping ─────────────────────────────────────────────────────

type StripOptions = { mode: 'strip' | 'transform'; sourceMap?: boolean; sourceUrl?: string };
type Strip = (source: string, options: StripOptions) => string;

let strip: Promise<Strip> | null = null;

/**
 * `node:module`'s `stripTypeScriptTypes` — present in Node ≥ 22.13 and in Deno — with Node's
 * one-time ExperimentalWarning kept off the run's output, where it would land in the TAP stream.
 */
function stripTypeScriptTypes(): Promise<Strip> {
  strip ??= import('node:module').then((mod) => {
    const builtin = (mod as unknown as { stripTypeScriptTypes?: Strip }).stripTypeScriptTypes;
    if (!builtin) {
      throw new Error(
        'this runtime cannot strip TypeScript types (needs Node.js >= 22.13 or Deno); run with --bundle',
      );
    }
    return (source, options) => {
      const emitWarning = process.emitWarning;
      process.emitWarning = () => {};
      try {
        return builtin(source, options);
      } finally {
        process.emitWarning = emitWarning;
      }
    };
  });

  return strip;
}
