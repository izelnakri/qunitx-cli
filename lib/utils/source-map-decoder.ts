/**
 * Inline source-map V3 decoder.
 * Resolves QUnit assertion stack frames (which point to the esbuild bundle) back to the
 * original source files so the TAP `at:` field shows the actual assertion location.
 *
 * Only the subset of the spec needed here is implemented: VLQ decoding, per-line segment
 * lookup, and Chrome/Firefox/WebKit stack-frame parsing.
 */

// No node:path — this module is bundled for browser test runs (esbuild can't resolve node:path).
// All path helpers below are minimal POSIX-only implementations that match what Node's path
// module would produce on Linux/macOS (the only platforms qunitx-cli supports).

// ── VLQ decoding ─────────────────────────────────────────────────────────────

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// Typed-array lookup: charCode → VLQ digit value (0–63).  Unmapped codes stay 0.
const BASE64_LOOKUP = new Uint8Array(128);
[...BASE64].forEach((ch, i) => {
  BASE64_LOOKUP[ch.charCodeAt(0)] = i;
});

/**
 * Reads one VLQ-encoded integer from `s` starting at `pos`.
 * Returns `[decodedValue, positionAfterLastConsumedChar]`.
 *
 * Each base64 character contributes 5 data bits (bits 0–4) and 1 continuation bit (bit 5).
 * The least-significant bit of the fully-accumulated value is the sign bit.
 */
export function readVLQ(s: string, pos: number): [value: number, nextPos: number] {
  let accumulated = 0;
  let shift = 0;
  let digit: number;
  do {
    digit = BASE64_LOOKUP[s.charCodeAt(pos++)];
    accumulated |= (digit & 0x1f) << shift; // lower 5 bits are data
    shift += 5;
  } while (digit & 0x20); // bit 5 = more VLQ digits follow
  // Bit 0 of the accumulated result encodes the sign.
  return [accumulated & 1 ? -(accumulated >>> 1) : accumulated >>> 1, pos];
}

// ── Mappings parser ───────────────────────────────────────────────────────────

/** One decoded mapping entry.  All coordinates are 0-based. */
export interface Segment {
  /** 0-based column in the generated (bundle) file. */
  generatedCol: number;
  /** Index into the source map's `sources` array. */
  sourceIndex: number;
  /** 0-based line in the original source file. */
  sourceLine: number;
  /** 0-based column in the original source file. */
  sourceCol: number;
}

/**
 * Parses the compact `mappings` string from a source-map V3 object into a per-line
 * array of segments, sorted by `generatedCol` (esbuild always emits them in order).
 *
 * Source-coordinate deltas (`sourceIndex`, `sourceLine`, `sourceCol`) are cumulative
 * across the entire string; only `generatedCol` resets to 0 at each new line.
 */
export function decodeMappings(mappings: string): Segment[][] {
  let sourceIndex = 0,
    sourceLine = 0,
    sourceCol = 0;

  return mappings.split(';').map((lineStr) => {
    const segments: Segment[] = [];
    let generatedCol = 0; // resets at each new generated line
    let pos = 0;

    while (pos < lineStr.length) {
      if (lineStr[pos] === ',') {
        pos++;
        continue;
      }

      let delta: number;
      [delta, pos] = readVLQ(lineStr, pos);
      generatedCol += delta;

      // A 1-field segment carries only a generated column — no source reference.
      if (pos >= lineStr.length || lineStr[pos] === ',') continue;

      [delta, pos] = readVLQ(lineStr, pos);
      sourceIndex += delta;
      [delta, pos] = readVLQ(lineStr, pos);
      sourceLine += delta;
      [delta, pos] = readVLQ(lineStr, pos);
      sourceCol += delta;

      // Optional 5th field: names index — not needed here, just advance `pos`.
      if (pos < lineStr.length && lineStr[pos] !== ',') [, pos] = readVLQ(lineStr, pos);

      segments.push({ generatedCol, sourceIndex, sourceLine, sourceCol });
    }

    return segments;
  });
}

// ── Decoder interface ─────────────────────────────────────────────────────────

/** Parsed representation of a source-map V3 JSON, ready for position lookup. */
export interface SourceMapDecoder {
  /** Decoded segments indexed by 0-based generated line number. */
  segmentsByLine: Segment[][];
  /** Raw source paths from the map (may be relative to `outDir`). */
  sources: string[];
  /** Source-root prefix from the map JSON (usually `""` for esbuild output). */
  sourceRoot: string;
  /** Absolute directory of the bundle file, used to resolve relative source paths. */
  outDir: string;
  /** Original source texts verbatim from the map JSON; one entry per `sources` element. */
  sourcesContent: (string | null)[];
}

/** Parses a source-map V3 JSON string into a `SourceMapDecoder` ready for position lookup. */
export function parseSourceMap(json: string, outDir: string): SourceMapDecoder {
  const map = JSON.parse(json) as {
    sources: string[];
    sourceRoot?: string;
    mappings: string;
    sourcesContent?: (string | null)[];
  };
  return {
    segmentsByLine: decodeMappings(map.mappings),
    sources: map.sources ?? [],
    sourceRoot: map.sourceRoot ?? '',
    outDir,
    sourcesContent: map.sourcesContent ?? [],
  };
}

// Shared decoder instance — TextDecoder is stateless; one instance is safe to reuse.
const UTF8 = new TextDecoder();

/**
 * Extracts and decodes the inline source map that esbuild appends to a bundle as
 * `//# sourceMappingURL=data:application/json;base64,…`.
 * Returns `null` when no inline map is present or parsing fails.
 * Accepts Buffer (Node.js) or Uint8Array (browser) as well as plain strings.
 */
export function extractInlineSourceMap(
  bundle: ArrayBufferView | string | null,
  outDir: string,
): SourceMapDecoder | null {
  if (!bundle) return null;
  const text = typeof bundle === 'string' ? bundle : UTF8.decode(bundle as ArrayBufferView);
  const match = text.match(
    /\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)/,
  );
  if (!match) return null;
  try {
    return parseSourceMap(base64DecodeUtf8(match[1]), outDir);
  } catch {
    return null;
  }
}

/**
 * Returns the original source position for a generated (line, col) pair.
 * Both coordinates are **1-based** (the format Chrome uses in `Error.stack`).
 * Returns `null` when the position cannot be mapped.
 */
export function lookupPosition(
  decoder: SourceMapDecoder,
  generatedLine: number, // 1-based
  generatedCol: number, // 1-based
): { absolutePath: string; line: number; col: number; sourceText: string | null } | null {
  const segments = decoder.segmentsByLine[generatedLine - 1];
  if (!segments?.length) return null;

  const col0 = generatedCol - 1; // source-map coords are 0-based
  // Binary search: last segment whose generatedCol ≤ col0.
  let lo = 0,
    hi = segments.length - 1,
    best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (segments[mid].generatedCol <= col0) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best === -1) return null; // column precedes every segment on this line

  const { sourceIndex, sourceLine, sourceCol } = segments[best];
  const rawSource = decoder.sources[sourceIndex];
  if (!rawSource) return null;

  const content = decoder.sourcesContent[sourceIndex];
  const sourceText = content
    ? content.split('\n', sourceLine + 1)[sourceLine]?.trim() || null
    : null;

  return {
    absolutePath: toAbsolutePath(rawSource, decoder.outDir, decoder.sourceRoot),
    line: sourceLine + 1, // 0-based → 1-based
    col: sourceCol + 1, // 0-based → 1-based
    sourceText,
  };
}

// ── Stack-frame resolution ────────────────────────────────────────────────────

/**
 * Parses the trailing `URL:LINE:COL` suffix of a stack frame by scanning from the right,
 * so URLs that contain colons (e.g. `http://host:PORT/path`) are handled correctly.
 */
export function parseFrameLocation(s: string): { url: string; line: number; col: number } | null {
  const colSep = s.lastIndexOf(':');
  if (colSep < 0) return null;
  const colStr = s.slice(colSep + 1);
  if (!/^\d+$/.test(colStr)) return null;

  const lineSep = s.lastIndexOf(':', colSep - 1);
  if (lineSep < 0) return null;
  const lineStr = s.slice(lineSep + 1, colSep);
  if (!/^\d+$/.test(lineStr)) return null;

  return { url: s.slice(0, lineSep), line: +lineStr, col: +colStr };
}

/** Returns `true` when `url` points to a test bundle (`/tests.js` or `/filtered-tests.js`) served by the local HTTP server. */
export function isBundleUrl(url: string): boolean {
  const normalized = url.startsWith('async ') ? url.slice(6) : url;
  return /^https?:\/\//.test(normalized) && /\/(tests|filtered-tests)\.js$/.test(normalized);
}

/**
 * Attempts to resolve a single stack-frame line to its original source location.
 * Handles Chrome named (`at FUNC (URL:L:C)`), Chrome anonymous (`at [async] URL:L:C`),
 * and Firefox/WebKit (`FUNC@URL:L:C`) formats.
 *
 * Returns `{ resolved, userPath, sourceText }` when the frame is from a test bundle and the
 * position can be mapped; `null` otherwise (caller keeps the original frame).
 * `userPath` and `sourceText` are non-null only when the resolved source is outside `node_modules/`.
 */
export function resolveFrame(
  frame: string,
  decoder: SourceMapDecoder,
  projectRoot: string,
): { resolved: string; userPath: string | null; sourceText: string | null } | null {
  // Chrome named: "    at FUNC (URL:LINE:COL)"
  const chromeName = frame.match(/^(\s*at\s+)(.*?)\s+\(([^)]+)\)\s*$/);
  if (chromeName) {
    const r = tryResolve(chromeName[3], decoder, projectRoot);
    return r
      ? {
          resolved: `${chromeName[1]}${chromeName[2]} (${r.display})`,
          userPath: r.userPath,
          sourceText: r.sourceText,
        }
      : null;
  }
  // Chrome anonymous (including `async`): "    at [async] URL:LINE:COL"
  const chromeAnon = frame.match(/^(\s*at\s+(?:async\s+)?)(.+)/);
  if (chromeAnon) {
    const r = tryResolve(chromeAnon[2], decoder, projectRoot);
    return r
      ? { resolved: `${chromeAnon[1]}${r.display}`, userPath: r.userPath, sourceText: r.sourceText }
      : null;
  }
  // Firefox / WebKit: "FUNC@URL:LINE:COL"
  const gecko = frame.match(/^([^@]*)@(.+)$/);
  if (gecko) {
    const r = tryResolve(gecko[2], decoder, projectRoot);
    return r
      ? { resolved: `${gecko[1]}@${r.display}`, userPath: r.userPath, sourceText: r.sourceText }
      : null;
  }
  return null;
}

/**
 * Resolves every frame in `stack` that references a test bundle to its original source.
 *
 * - `resolvedStack`: the same stack with bundle frames rewritten to original paths.
 * - `firstUserFrame`: the first frame that resolves outside `node_modules/` (the actual
 *   assertion call-site), as `"path:line:col"` suitable for the TAP `at:` field.
 * - `firstUserSourceText`: the trimmed source line at the first user frame (from `sourcesContent`),
 *   or `null` when the map has no embedded source text.
 *
 * Frames from native code, external scripts, or unknown formats are left unchanged.
 */
export function resolveStack(
  stack: string,
  decoder: SourceMapDecoder,
  projectRoot: string,
): { resolvedStack: string; firstUserFrame: string | null; firstUserSourceText: string | null } {
  let firstUserFrame: string | null = null;
  let firstUserSourceText: string | null = null;

  const resolvedLines = stack.split('\n').map((frame) => {
    const result = resolveFrame(frame, decoder, projectRoot);
    if (!result) return frame;
    if (!firstUserFrame && result.userPath) {
      firstUserFrame = result.userPath;
      firstUserSourceText = result.sourceText;
    }
    return result.resolved;
  });

  return { resolvedStack: resolvedLines.join('\n'), firstUserFrame, firstUserSourceText };
}

// Browser-compatible base64 → UTF-8 decode (atob + TextDecoder are global in browsers and Node 16+).
function base64DecodeUtf8(b64: string): string {
  const binary = atob(b64);
  return UTF8.decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

// ── Position lookup ───────────────────────────────────────────────────────────

// Resolve `..` and `.` components in a POSIX path string.
function normalizePosix(p: string): string {
  const abs = p.startsWith('/');
  const parts = p.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part !== '' && part !== '.') out.push(part);
  }
  return (abs ? '/' : '') + out.join('/');
}

// path.resolve(base, relative) — base must be absolute.
function posixResolve(base: string, relative: string): string {
  if (relative.startsWith('/')) return normalizePosix(relative);
  return normalizePosix(base + '/' + relative);
}

function toAbsolutePath(raw: string, outDir: string, sourceRoot: string): string {
  if (raw.startsWith('file://')) return raw.slice(7);
  if (raw.startsWith('/')) return raw; // already absolute
  const base = sourceRoot ? normalizePosix(outDir + '/' + sourceRoot) : outDir;
  return posixResolve(base, raw);
}

function isNodeModulesPath(absolutePath: string): boolean {
  return absolutePath.includes('/node_modules/') || absolutePath.includes('\\node_modules\\');
}

function makeDisplayPath(absolutePath: string, projectRoot: string): string {
  const prefix = projectRoot + '/';
  return absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : absolutePath;
}

/** Resolves a `URL:LINE:COL` string to a display path + userPath + sourceText, or null on miss. */
function tryResolve(
  urlLineCol: string,
  decoder: SourceMapDecoder,
  projectRoot: string,
): { display: string; userPath: string | null; sourceText: string | null } | null {
  const loc = parseFrameLocation(urlLineCol);
  if (!loc || !isBundleUrl(loc.url)) return null;
  const orig = lookupPosition(decoder, loc.line, loc.col);
  if (!orig) return null;
  const display = `${makeDisplayPath(orig.absolutePath, projectRoot)}:${orig.line}:${orig.col}`;
  return {
    display,
    userPath: isNodeModulesPath(orig.absolutePath) ? null : display,
    sourceText: orig.sourceText,
  };
}
