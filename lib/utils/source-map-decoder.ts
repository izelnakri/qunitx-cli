/**
 * Inline source-map V3 decoder.
 * Resolves QUnit assertion stack frames (which point to the esbuild bundle) back to the
 * original source files so the TAP `at:` field shows the actual assertion location.
 *
 * Only the subset of the spec needed here is implemented: VLQ decoding, per-line segment
 * lookup, and Chrome/Firefox/WebKit stack-frame parsing.
 *
 * Performance: decodeMappings is single-pass with VLQ extracted into a small cursor-based
 * helper (V8 inlines it; benchmarked within noise of the unrolled inline version, and ~9×
 * faster than the original split(';') + tuple-returning readVLQ implementation).
 * extractInlineSourceMap reverse-scans Buffer/Uint8Array bundles in place — they are
 * never decoded to a full UTF-8 string.
 *
 * Browser compatibility: no node:* imports.  Buffer-backed fast paths are feature-detected
 * at module load and fall back to atob/TextDecoder when Buffer is absent.
 */

// ── Constants & lookup tables ────────────────────────────────────────────────

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// charCode → VLQ digit value (0–63).  Unmapped codes stay 0.
const BASE64_LOOKUP = new Uint8Array(128);
[...BASE64_ALPHABET].forEach((char, index) => (BASE64_LOOKUP[char.charCodeAt(0)] = index));

const COMMA = 0x2c;
const SEMICOLON = 0x3b;
const NEWLINE = 0x0a;
// Bit 5 of a base64 VLQ digit is the continuation flag; bits 0–4 are 5 data bits.
const VLQ_CONTINUATION = 0x20;
const VLQ_DATA_MASK = 0x1f;

const SOURCE_MAP_MARKER = '//# sourceMappingURL=data:application/json;base64,';
// Trailing "URL:LINE:COL" anchored at end-of-string; greedy URL captures everything up to
// the last two `:digits` segments, so URLs containing `:port` are handled correctly.
const FRAME_LOCATION_RE = /^(.+):(\d+):(\d+)$/;
// http(s) bundle URLs the local server serves, optionally Chrome's `async ` prefix.
const BUNDLE_URL_RE = /^(?:async )?https?:\/\/.*\/(?:tests|filtered-tests)\.js$/;

// Recognised stack-frame layouts, tried in order.  First whose pattern matches wins —
// even if its URL fails to resolve (caller falls back to keeping the original frame).
const FRAME_FORMATS: ReadonlyArray<{
  pattern: RegExp;
  urlGroup: number;
  format: (match: RegExpMatchArray, displayPath: string) => string;
}> = [
  // Chrome named: "    at FUNC (URL:LINE:COL)"
  {
    pattern: /^(\s*at\s+)(.*?)\s+\(([^)]+)\)\s*$/,
    urlGroup: 3,
    format: (match, displayPath) => `${match[1]}${match[2]} (${displayPath})`,
  },
  // Chrome anonymous (incl. async): "    at [async] URL:LINE:COL"
  {
    pattern: /^(\s*at\s+(?:async\s+)?)(.+)/,
    urlGroup: 2,
    format: (match, displayPath) => `${match[1]}${displayPath}`,
  },
  // Firefox / WebKit: "FUNC@URL:LINE:COL"
  {
    pattern: /^([^@]*)@(.+)$/,
    urlGroup: 2,
    format: (match, displayPath) => `${match[1]}@${displayPath}`,
  },
];

// Node.js fast paths.  When Buffer is absent (browser bundle) we fall through to
// atob + TextDecoder; both are slower but functionally equivalent.
const HAS_BUFFER = typeof Buffer !== 'undefined';
const SOURCE_MAP_MARKER_BYTES = HAS_BUFFER ? Buffer.from(SOURCE_MAP_MARKER, 'utf8') : null;

const UTF8_DECODER = new TextDecoder();

// ── Types ────────────────────────────────────────────────────────────────────

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

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Reads one VLQ-encoded integer from `text` starting at `position`.
 * Returns `[decodedValue, positionAfterLastConsumedChar]`.
 *
 * Each base64 character contributes 5 data bits (bits 0–4) and 1 continuation bit (bit 5).
 * The least-significant bit of the fully-accumulated value is the sign bit.
 */
export function readVLQ(text: string, position: number): [value: number, nextPos: number] {
  const cursor = { position };
  return [readVlqAt(text, cursor), cursor.position];
}

/**
 * Parses the compact `mappings` string from a source-map V3 object into a per-line
 * array of segments, sorted by `generatedCol` (esbuild always emits them in order).
 *
 * Source-coordinate deltas (`sourceIndex`, `sourceLine`, `sourceCol`) are cumulative
 * across the entire string; only `generatedCol` resets to 0 at each new line.
 *
 * `mappings.length` is read into a local because V8 won't reliably hoist string-length
 * accesses out of a hot loop containing further string ops.  Branches are ordered by
 * descending frequency: the VLQ default fires for every segment (~64K calls per real
 * bundle), `,` fires N − L times, `;` only L − 1 times.
 */
export function decodeMappings(mappings: string): Segment[][] {
  const result: Segment[][] = [];
  const cursor = { position: 0 };
  const mappingsLength = mappings.length;
  let segments: Segment[] = [];
  let generatedCol = 0,
    sourceIndex = 0,
    sourceLine = 0,
    sourceCol = 0;

  for (;;) {
    if (cursor.position >= mappingsLength) break;
    const charCode = mappings.charCodeAt(cursor.position);
    if (charCode !== COMMA && charCode !== SEMICOLON) {
      generatedCol += readVlqAt(mappings, cursor);
      // 1-field segment (generated column only) → no source ref, skip the push.
      if (atFieldStart(mappings, cursor.position)) {
        sourceIndex += readVlqAt(mappings, cursor);
        sourceLine += readVlqAt(mappings, cursor);
        sourceCol += readVlqAt(mappings, cursor);
        segments.push({ generatedCol, sourceIndex, sourceLine, sourceCol });
        // Optional 5th field (names index): consume and discard.
        if (atFieldStart(mappings, cursor.position)) readVlqAt(mappings, cursor);
      }
    } else if (charCode === COMMA) {
      cursor.position++;
    } else {
      result.push(segments);
      segments = [];
      generatedCol = 0;
      cursor.position++;
    }
  }
  result.push(segments);
  return result;
}

/** Parses a source-map V3 JSON string into a `SourceMapDecoder` ready for position lookup. */
export function parseSourceMap(json: string, outDir: string): SourceMapDecoder {
  const map = JSON.parse(json) as {
    sources?: string[];
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

/**
 * Extracts and decodes the inline source map that esbuild appends to a bundle as
 * `//# sourceMappingURL=data:application/json;base64,…`.
 * Returns `null` when no inline map is present or parsing fails.
 *
 * Buffer/Uint8Array bundles are scanned in-place from the tail; the bundle itself is
 * never decoded to a full UTF-8 string.
 */
export function extractInlineSourceMap(
  bundle: ArrayBufferView | string | null,
  outDir: string,
): SourceMapDecoder | null {
  if (!bundle) return null;
  const base64Payload = readMarkerPayload(bundle);
  if (!base64Payload) return null;
  try {
    return parseSourceMap(decodeBase64Utf8(base64Payload), outDir);
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
  // Last segment whose generatedCol ≤ (col − 1).  Segments are sorted ascending by
  // generatedCol, so findLast scans from the end and short-circuits at the boundary.
  const targetCol = generatedCol - 1;
  const segment = segments.findLast((s) => s.generatedCol <= targetCol);
  if (!segment) return null;
  const rawSource = decoder.sources[segment.sourceIndex];
  if (!rawSource) return null;
  return {
    absolutePath: toAbsolutePath(rawSource, decoder.outDir, decoder.sourceRoot),
    line: segment.sourceLine + 1,
    col: segment.sourceCol + 1,
    sourceText: extractSourceLine(decoder.sourcesContent[segment.sourceIndex], segment.sourceLine),
  };
}

/**
 * Parses the trailing `URL:LINE:COL` suffix of a stack frame.  The greedy `(.+)` group
 * captures URLs that contain colons (e.g. `http://host:PORT/path`); the regex anchors
 * mean the last two `:digits` sequences are always the line/col.
 */
export function parseFrameLocation(
  text: string,
): { url: string; line: number; col: number } | null {
  const match = FRAME_LOCATION_RE.exec(text);
  return match ? { url: match[1], line: +match[2], col: +match[3] } : null;
}

/** Returns `true` when `url` points to a test bundle (`/tests.js` or `/filtered-tests.js`) served by the local HTTP server. */
export function isBundleUrl(url: string): boolean {
  return BUNDLE_URL_RE.test(url);
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
  const hit = FRAME_FORMATS.map((format) => ({ format, match: frame.match(format.pattern) })).find(
    ({ match }) => match !== null,
  );
  if (!hit?.match) return null;
  const original = tryResolve(hit.match[hit.format.urlGroup], decoder, projectRoot);
  return (
    original && {
      resolved: hit.format.format(hit.match, original.display),
      userPath: original.userPath,
      sourceText: original.sourceText,
    }
  );
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
  const decoratedFrames = stack.split('\n').map((frame) => {
    const resolution = resolveFrame(frame, decoder, projectRoot);
    return {
      line: resolution?.resolved ?? frame,
      userPath: resolution?.userPath ?? null,
      sourceText: resolution?.sourceText ?? null,
    };
  });
  const firstUser = decoratedFrames.find((entry) => entry.userPath !== null);
  return {
    resolvedStack: decoratedFrames.map((entry) => entry.line).join('\n'),
    firstUserFrame: firstUser?.userPath ?? null,
    firstUserSourceText: firstUser?.sourceText ?? null,
  };
}

// ── Private helpers ──────────────────────────────────────────────────────────

/**
 * Read one VLQ integer at `cursor.position`, advancing it past the consumed digits.
 * The condition naturally goes at the bottom of the body (we always read at least one
 * digit, then continue while the continuation bit is set) — `for (;;) { …; break }`
 * expresses that with the exit check beside the read instead of dangling on a `} while`.
 * V8 generates identical machine code for this and `do { … } while (…)`.
 */
function readVlqAt(text: string, cursor: { position: number }): number {
  let value = 0,
    bitShift = 0,
    position = cursor.position;
  for (;;) {
    const digit = BASE64_LOOKUP[text.charCodeAt(position++)];
    value |= (digit & VLQ_DATA_MASK) << bitShift;
    if (!(digit & VLQ_CONTINUATION)) break;
    bitShift += 5;
  }
  cursor.position = position;
  return value & 1 ? -(value >>> 1) : value >>> 1;
}

/** True when `position` points at the first VLQ digit of a new field (not at `,` `;` or end). */
function atFieldStart(text: string, position: number): boolean {
  if (position >= text.length) return false;
  const charCode = text.charCodeAt(position);
  return charCode !== COMMA && charCode !== SEMICOLON;
}

/** Decode a base64 ASCII string to UTF-8.  Uses Node's Buffer when available. */
function decodeBase64Utf8(base64: string): string {
  if (HAS_BUFFER) return Buffer.from(base64, 'base64').toString('utf8');
  return UTF8_DECODER.decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)));
}

/** Find the inline source-map marker in any supported bundle shape; return its base64 payload. */
function readMarkerPayload(bundle: ArrayBufferView | string): string | null {
  if (typeof bundle === 'string') return sliceMarkerFromString(bundle);
  if (HAS_BUFFER) return sliceMarkerFromBuffer(asBuffer(bundle));
  return sliceMarkerFromString(UTF8_DECODER.decode(bundle));
}

/** Wrap an arbitrary ArrayBufferView as a Buffer view (zero-copy in Node). */
function asBuffer(view: ArrayBufferView): Buffer {
  return Buffer.isBuffer(view) ? view : Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

/** Tail-search a string for the inline source-map marker; returns the base64 payload or null. */
function sliceMarkerFromString(text: string): string | null {
  const markerStart = text.lastIndexOf(SOURCE_MAP_MARKER);
  if (markerStart < 0) return null;
  const payloadStart = markerStart + SOURCE_MAP_MARKER.length;
  const payloadEnd = text.indexOf('\n', payloadStart);
  return (payloadEnd < 0 ? text.slice(payloadStart) : text.slice(payloadStart, payloadEnd)).trim();
}

/** Tail-search a Node Buffer for the marker bytes; returns the base64 payload or null. */
function sliceMarkerFromBuffer(buffer: Buffer): string | null {
  const markerBytes = SOURCE_MAP_MARKER_BYTES!;
  const markerStart = buffer.lastIndexOf(markerBytes);
  if (markerStart < 0) return null;
  const payloadStart = markerStart + markerBytes.length;
  const newlineIndex = buffer.indexOf(NEWLINE, payloadStart);
  const payloadEnd = newlineIndex < 0 ? buffer.length : newlineIndex;
  // base64 is pure ASCII; 'latin1' is the fastest 1:1 byte-to-char conversion.
  return buffer.toString('latin1', payloadStart, payloadEnd).trim();
}

/** Returns the trimmed Nth (0-based) line of `content`, or null when blank/missing/null content. */
function extractSourceLine(content: string | null, lineIndex: number): string | null {
  if (!content || lineIndex < 0) return null;
  const line = content.split('\n', lineIndex + 1)[lineIndex];
  return line?.trim() || null;
}

/** Resolve `..` and `.` components in a POSIX path string. */
function normalizePosix(path: string): string {
  const parts = path.split('/').reduce<string[]>((acc, part) => {
    if (part === '..') acc.pop();
    else if (part && part !== '.') acc.push(part);
    return acc;
  }, []);
  return (path.startsWith('/') ? '/' : '') + parts.join('/');
}

function toAbsolutePath(rawSource: string, outDir: string, sourceRoot: string): string {
  if (rawSource.startsWith('file://')) return rawSource.slice(7);
  if (rawSource.startsWith('/')) return rawSource;
  const base = sourceRoot ? normalizePosix(`${outDir}/${sourceRoot}`) : outDir;
  return normalizePosix(`${base}/${rawSource}`);
}

function isNodeModulesPath(path: string): boolean {
  return path.includes('/node_modules/') || path.includes('\\node_modules\\');
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
  const location = parseFrameLocation(urlLineCol);
  if (!location || !isBundleUrl(location.url)) return null;
  const original = lookupPosition(decoder, location.line, location.col);
  if (!original) return null;
  const display = `${makeDisplayPath(original.absolutePath, projectRoot)}:${original.line}:${original.col}`;
  return {
    display,
    userPath: isNodeModulesPath(original.absolutePath) ? null : display,
    sourceText: original.sourceText,
  };
}
