import fs from 'node:fs/promises';
import path from 'node:path';
import { isBundleUrl, sourceAbsolutePath } from '../utils/source-map-decoder.ts';
import type { SourceMapDecoder } from '../utils/source-map-decoder.ts';
import type { Config, CoverageFileMap } from '../types.ts';

/**
 * Collects V8 line coverage from a page's `stopJSCoverage()` result and merges it into the
 * run's shared coverage map.
 *
 * Approach (line coverage): V8 reports per-function byte-offset ranges with hit counts against
 * the *bundle* (tests.js). We paint those counts across the bundle, then walk the bundle's
 * source-map segments — each maps a bundle position back to an original (file, line) — and mark
 * that original line coverable, and covered when the painted count at the mapped position is > 0.
 * This reuses the same decoded source map the TAP `at:` resolver already builds, and attributes
 * coverage to the original files the user wrote rather than the concatenated bundle.
 *
 * node_modules sources are dropped here; the report layer additionally drops the test entry files.
 */
interface V8ScriptCoverage {
  url: string;
  scriptId: string;
  source?: string;
  functions: Array<{
    functionName: string;
    isBlockCoverage: boolean;
    ranges: Array<{ count: number; startOffset: number; endOffset: number }>;
  }>;
}

/**
 * Merges one page's `stopJSCoverage()` result into `config._coverageCollector`. No-op unless
 * coverage is enabled and a source-map decoder is present. Only the test bundle is attributed;
 * node_modules sources are dropped here (test entry files are dropped later, in the report layer).
 */
export async function collectCoverage(config: Config, entries: V8ScriptCoverage[]): Promise<void> {
  const decoder = config._sourceMapDecoder;
  const collector = config._coverageCollector;
  if (!decoder || !collector) return;

  for (const entry of entries) {
    if (!isBundleUrl(entry.url)) continue;
    // Playwright's `source` is often empty for the served bundle; the on-disk tests.js the server
    // wrote is byte-identical to what V8 measured (same buffer), so read it as a fallback. V8
    // ranges are offsets into that exact text, so the source must match the served bytes precisely.
    const source = entry.source || (await readBundleSource(config, entry.url));
    if (!source) continue;
    attributeEntry(source, entry.functions, decoder, collector);
  }
}

export { collectCoverage as default };

/** Reads the served bundle (`tests.js` / `filtered-tests.js`) from the group's output dir. */
function readBundleSource(config: Config, url: string): Promise<string | null> {
  const fileName = url.endsWith('filtered-tests.js') ? 'filtered-tests.js' : 'tests.js';
  const bundlePath = path.join(path.resolve(config.projectRoot, config.output), fileName);
  return fs.readFile(bundlePath, 'utf8').catch(() => null);
}

function attributeEntry(
  source: string,
  functions: V8ScriptCoverage['functions'],
  decoder: SourceMapDecoder,
  collector: CoverageFileMap,
): void {
  const counts = paintCounts(source, functions);
  const lineStarts = computeLineStarts(source);
  const sourceLength = source.length;
  const segmentsByLine = decoder.segmentsByLine;
  // Cache per-sourceIndex absolute-path resolution (null = excluded, e.g. node_modules).
  const pathCache = new Map<number, string | null>();

  for (let generatedLine = 0; generatedLine < segmentsByLine.length; generatedLine++) {
    const segments = segmentsByLine[generatedLine];
    if (!segments || segments.length === 0) continue;
    const lineStart = lineStarts[generatedLine];
    if (lineStart === undefined) continue;

    for (const segment of segments) {
      const offset = lineStart + segment.generatedCol;
      if (offset >= sourceLength) continue;
      const count = counts[offset];
      if (count < 0) continue; // no V8 range covered this position — unknown, skip

      let absolutePath = pathCache.get(segment.sourceIndex);
      if (absolutePath === undefined) {
        absolutePath = resolveIncludedSource(decoder, segment.sourceIndex);
        pathCache.set(segment.sourceIndex, absolutePath);
      }
      if (absolutePath === null) continue;

      let fileCoverage = collector.get(absolutePath);
      if (!fileCoverage) {
        fileCoverage = {
          coverable: new Set<number>(),
          covered: new Map<number, number>(),
          sourceContent: decoder.sourcesContent[segment.sourceIndex] ?? null,
        };
        collector.set(absolutePath, fileCoverage);
      }

      const line = segment.sourceLine + 1; // decoder lines are 0-based; report/lcov are 1-based
      fileCoverage.coverable.add(line);
      if (count > 0) {
        const previous = fileCoverage.covered.get(line) ?? 0;
        if (count > previous) fileCoverage.covered.set(line, count);
      }
    }
  }
}

/** Returns the absolute source path for `sourceIndex`, or `null` for node_modules / unresolvable. */
function resolveIncludedSource(decoder: SourceMapDecoder, sourceIndex: number): string | null {
  const absolutePath = sourceAbsolutePath(decoder, sourceIndex);
  if (!absolutePath) return null;
  if (absolutePath.includes('/node_modules/') || absolutePath.includes('\\node_modules\\')) {
    return null;
  }
  return absolutePath;
}

/**
 * Builds a per-character hit-count array for the bundle. `-1` marks positions no V8 range
 * covered (unknown). Ranges are painted outermost-first (start ascending, then end descending),
 * so a nested block's count correctly overwrites its enclosing function's count — the standard
 * V8 block-coverage nesting rule.
 */
function paintCounts(source: string, functions: V8ScriptCoverage['functions']): Int32Array {
  const counts = new Int32Array(source.length).fill(-1);
  const ranges: Array<{ count: number; startOffset: number; endOffset: number }> = [];
  for (const fn of functions) {
    for (const range of fn.ranges) ranges.push(range);
  }
  ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);

  for (const range of ranges) {
    const end = Math.min(range.endOffset, source.length);
    for (let i = range.startOffset; i < end; i++) counts[i] = range.count;
  }
  return counts;
}

/** Offset of the first character of each 0-based line in `source`. */
function computeLineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}
