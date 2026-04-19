import { module, test } from 'qunitx';
import {
  readVLQ,
  decodeMappings,
  parseSourceMap,
  extractInlineSourceMap,
  lookupPosition,
  parseFrameLocation,
  isBundleUrl,
  resolveFrame,
  resolveStack,
  type Segment,
  type SourceMapDecoder,
} from '../../lib/utils/source-map-decoder.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal SourceMapDecoder directly from a segments table (no JSON/VLQ needed). */
function makeDecoder(
  segmentsByLine: Segment[][],
  sources: string[],
  outDir = '/project/tmp',
  sourceRoot = '',
  sourcesContent: (string | null)[] = [],
): SourceMapDecoder {
  return { segmentsByLine, sources, sourceRoot, outDir, sourcesContent };
}

/**
 * Encode a source map JSON as a base64 inline data URL and wrap it in a fake bundle string.
 * Used to test `extractInlineSourceMap` end-to-end.
 */
function bundleWithInlineMap(mapJson: object): string {
  const b64 = btoa(JSON.stringify(mapJson));
  return `console.log("bundle");\n//# sourceMappingURL=data:application/json;base64,${b64}`;
}

// ── readVLQ ───────────────────────────────────────────────────────────────────

module('Utils | source-map-decoder | readVLQ', { concurrency: true }, () => {
  test('A encodes 0', (assert) => {
    const [value, nextPos] = readVLQ('A', 0);
    assert.strictEqual(value, 0);
    assert.strictEqual(nextPos, 1);
  });

  test('C encodes +1', (assert) => {
    const [value] = readVLQ('C', 0);
    assert.strictEqual(value, 1);
  });

  test('D encodes -1', (assert) => {
    const [value] = readVLQ('D', 0);
    assert.strictEqual(value, -1);
  });

  test('E encodes +2', (assert) => {
    const [value] = readVLQ('E', 0);
    assert.strictEqual(value, 2);
  });

  test('F encodes -2', (assert) => {
    const [value] = readVLQ('F', 0);
    assert.strictEqual(value, -2);
  });

  test('Q encodes +8', (assert) => {
    const [value] = readVLQ('Q', 0);
    assert.strictEqual(value, 8);
  });

  test('gB encodes +16 (two-char VLQ)', (assert) => {
    // 16 → sign=0, encoded=32 → first digit=0 with cont bit, second digit=1
    const [value, nextPos] = readVLQ('gB', 0);
    assert.strictEqual(value, 16);
    assert.strictEqual(nextPos, 2, 'two chars consumed');
  });

  test('hB encodes -16 (two-char VLQ, negative)', (assert) => {
    const [value, nextPos] = readVLQ('hB', 0);
    assert.strictEqual(value, -16);
    assert.strictEqual(nextPos, 2);
  });

  test('pos offset: reads from the middle of the string', (assert) => {
    const [value, nextPos] = readVLQ('AACAA', 2); // 'C' at index 2
    assert.strictEqual(value, 1);
    assert.strictEqual(nextPos, 3);
  });

  test('returns updated nextPos so the caller can chain calls', (assert) => {
    // Decode two consecutive VLQ values from one string.
    const s = 'CE'; // 'C'=+1, 'E'=+2
    const [v1, p1] = readVLQ(s, 0);
    const [v2, p2] = readVLQ(s, p1);
    assert.strictEqual(v1, 1);
    assert.strictEqual(v2, 2);
    assert.strictEqual(p2, 2, 'both chars consumed');
  });

  test('three-char VLQ encodes +1024', (assert) => {
    // 1024 → encoded=2048 → bits: 00000 | 00000 | 00010 with two continuation chars
    // 'g'=32 (cont), 'g'=32 (cont), 'C'=2 (stop) → 0 | (0<<5) | (2<<10) = 2048 → +1024
    const [value, nextPos] = readVLQ('ggC', 0);
    assert.strictEqual(value, 1024);
    assert.strictEqual(nextPos, 3, 'three chars consumed');
  });

  test('three-char VLQ encodes -1024', (assert) => {
    // -1024 → encoded=2049 → bits: 00001 | 00000 | 00010 with two continuation chars
    // 'h'=33 (cont), 'g'=32 (cont), 'C'=2 (stop) → 1 | (0<<5) | (2<<10) = 2049 → -1024
    const [value, nextPos] = readVLQ('hgC', 0);
    assert.strictEqual(value, -1024);
    assert.strictEqual(nextPos, 3, 'three chars consumed');
  });
});

// ── decodeMappings ────────────────────────────────────────────────────────────

module('Utils | source-map-decoder | decodeMappings', { concurrency: true }, () => {
  test('empty string produces no lines', (assert) => {
    const lines = decodeMappings('');
    assert.deepEqual(lines, [[]], 'one empty line for the empty string');
  });

  test('AAAA produces a single segment at origin', (assert) => {
    const lines = decodeMappings('AAAA');
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].length, 1);
    assert.deepEqual(lines[0][0], { generatedCol: 0, sourceIndex: 0, sourceLine: 0, sourceCol: 0 });
  });

  test('semicolon creates a new generated line', (assert) => {
    const lines = decodeMappings('AAAA;AAAA');
    assert.strictEqual(lines.length, 2, 'two generated lines');
    assert.strictEqual(lines[0].length, 1);
    assert.strictEqual(lines[1].length, 1);
  });

  test('generatedCol resets to 0 at each new line', (assert) => {
    // Second line has generatedCol delta = +4 (I = 4th positive = 4)
    const lines = decodeMappings('QAAA;IAAA'); // Q=+8 col, I=+4 col
    assert.strictEqual(lines[0][0].generatedCol, 8, 'line 0 col');
    assert.strictEqual(lines[1][0].generatedCol, 4, 'line 1 col resets and delta applies fresh');
  });

  test('sourceLine delta is cumulative across lines', (assert) => {
    // Line 0: AAAA → sl=0.  Line 1: AACA → delta sl=+1 → sl=1.
    const lines = decodeMappings('AAAA;AACA');
    assert.strictEqual(lines[0][0].sourceLine, 0);
    assert.strictEqual(lines[1][0].sourceLine, 1, 'sl cumulative across line break');
  });

  test('sourceIndex delta is cumulative across lines', (assert) => {
    // Line 0: AAAA → si=0.  Line 1: ACAA → delta si=+1 → si=1.
    const lines = decodeMappings('AAAA;ACAA');
    assert.strictEqual(lines[0][0].sourceIndex, 0);
    assert.strictEqual(lines[1][0].sourceIndex, 1);
  });

  test('comma separates segments within a line', (assert) => {
    const lines = decodeMappings('AAAA,QAAA');
    assert.strictEqual(lines[0].length, 2);
    assert.strictEqual(lines[0][0].generatedCol, 0);
    assert.strictEqual(lines[0][1].generatedCol, 8, 'delta Q=+8 applied to previous gc=0');
  });

  test('1-field segment (only generated column) is skipped', (assert) => {
    // 'A' alone = 1-field segment (no source reference).  'AAAA' = full 4-field segment.
    const lines = decodeMappings('A,AAAA');
    assert.strictEqual(lines[0].length, 1, 'only the 4-field segment is stored');
    assert.strictEqual(lines[0][0].generatedCol, 0);
  });

  test('consecutive empty lines produce empty segment arrays', (assert) => {
    const lines = decodeMappings(';;;');
    assert.strictEqual(lines.length, 4);
    for (const segs of lines) assert.strictEqual(segs.length, 0);
  });

  test('two segments in same line have independent generatedCol deltas', (assert) => {
    // AAAA (gc=0), then QAAA (delta gc=+8 → gc=8), then QAAA (delta gc=+8 → gc=16)
    const lines = decodeMappings('AAAA,QAAA,QAAA');
    assert.strictEqual(lines[0][0].generatedCol, 0);
    assert.strictEqual(lines[0][1].generatedCol, 8);
    assert.strictEqual(lines[0][2].generatedCol, 16);
  });

  test('5-field segment (names index skipped) produces same result as 4-field', (assert) => {
    // 'AAAAA': gc=0, si=0, sl=0, sc=0, namesIdx=0 (5th field, consumed but ignored)
    assert.deepEqual(decodeMappings('AAAAA')[0], decodeMappings('AAAA')[0]);
  });

  test('negative source-line delta navigates backward in the source file', (assert) => {
    // Line 0: sl=0; Line 1: delta+1 → sl=1; Line 2: delta-1 (D=-1) → sl=0
    const lines = decodeMappings('AAAA;AACA;AADA');
    assert.strictEqual(lines[0][0].sourceLine, 0);
    assert.strictEqual(lines[1][0].sourceLine, 1);
    assert.strictEqual(lines[2][0].sourceLine, 0, 'negative delta returns to original source line');
  });

  test('sourceCol delta is cumulative across generated lines', (assert) => {
    // Line 0: AAAC → sc=+1 → sc=1; Line 1: AAAC → delta sc=+1 → sc=2
    const lines = decodeMappings('AAAC;AAAC');
    assert.strictEqual(lines[0][0].sourceCol, 1);
    assert.strictEqual(lines[1][0].sourceCol, 2, 'sc accumulates across line breaks');
  });
});

// ── parseSourceMap ─────────────────────────────────────────────────────────────

module('Utils | source-map-decoder | parseSourceMap', { concurrency: true }, () => {
  test('parses sources array', (assert) => {
    const decoder = parseSourceMap(
      JSON.stringify({ sources: ['../src/a.ts', '../src/b.ts'], mappings: 'AAAA' }),
      '/out',
    );
    assert.deepEqual(decoder.sources, ['../src/a.ts', '../src/b.ts']);
  });

  test('defaults missing sourceRoot to empty string', (assert) => {
    const decoder = parseSourceMap(JSON.stringify({ sources: [], mappings: '' }), '/out');
    assert.strictEqual(decoder.sourceRoot, '');
  });

  test('stores provided sourceRoot', (assert) => {
    const decoder = parseSourceMap(
      JSON.stringify({ sources: [], sourceRoot: 'webpack://', mappings: '' }),
      '/out',
    );
    assert.strictEqual(decoder.sourceRoot, 'webpack://');
  });

  test('stores outDir', (assert) => {
    const decoder = parseSourceMap(JSON.stringify({ sources: [], mappings: '' }), '/my/out/dir');
    assert.strictEqual(decoder.outDir, '/my/out/dir');
  });

  test('missing sources defaults to empty array', (assert) => {
    const decoder = parseSourceMap(JSON.stringify({ mappings: 'AAAA' }), '/out');
    assert.deepEqual(decoder.sources, []);
  });

  test('stores sourcesContent array when present', (assert) => {
    const decoder = parseSourceMap(
      JSON.stringify({ sources: ['a.ts'], sourcesContent: ['const x = 1;'], mappings: '' }),
      '/out',
    );
    assert.deepEqual(decoder.sourcesContent, ['const x = 1;']);
  });

  test('sourcesContent defaults to empty array when absent', (assert) => {
    const decoder = parseSourceMap(JSON.stringify({ sources: [], mappings: '' }), '/out');
    assert.deepEqual(decoder.sourcesContent, []);
  });

  test('sourcesContent preserves null entries', (assert) => {
    const decoder = parseSourceMap(
      JSON.stringify({
        sources: ['a.ts', 'b.ts'],
        sourcesContent: [null, 'const y = 2;'],
        mappings: '',
      }),
      '/out',
    );
    assert.deepEqual(decoder.sourcesContent, [null, 'const y = 2;']);
  });
});

// ── extractInlineSourceMap ─────────────────────────────────────────────────────

module('Utils | source-map-decoder | extractInlineSourceMap', { concurrency: true }, () => {
  test('returns null for null bundle', (assert) => {
    assert.strictEqual(extractInlineSourceMap(null, '/out'), null);
  });

  test('returns null when bundle has no source map comment', (assert) => {
    assert.strictEqual(extractInlineSourceMap('console.log("hi");', '/out'), null);
  });

  test('extracts and parses inline source map from string bundle', (assert) => {
    const bundle = bundleWithInlineMap({
      sources: ['../../src/test.ts'],
      mappings: 'AAAA',
    });
    const decoder = extractInlineSourceMap(bundle, '/project/tmp');
    assert.notEqual(decoder, null, 'decoder must be returned');
    assert.deepEqual(decoder!.sources, ['../../src/test.ts']);
    assert.strictEqual(decoder!.outDir, '/project/tmp');
  });

  test('extracts and parses inline source map from Uint8Array bundle', (assert) => {
    const bundle = bundleWithInlineMap({ sources: ['../test.ts'], mappings: 'AAAA' });
    const decoder = extractInlineSourceMap(new TextEncoder().encode(bundle), '/out');
    assert.notEqual(decoder, null);
    assert.deepEqual(decoder!.sources, ['../test.ts']);
  });

  test('returns null when base64 payload is not valid JSON', (assert) => {
    const bad = '//# sourceMappingURL=data:application/json;base64,' + btoa('not json');
    assert.strictEqual(extractInlineSourceMap(bad, '/out'), null);
  });
});

// ── lookupPosition ─────────────────────────────────────────────────────────────

// Shared decoder for lookupPosition tests:
//   Line 1 (index 0): two segments
//     gc=0  → sources[0] (user test file), sl=0, sc=0
//     gc=10 → sources[1] (node_modules), sl=5, sc=3
//   Line 2 (index 1): one segment
//     gc=0  → sources[0], sl=10, sc=0
const LOOKUP_DECODER = makeDecoder(
  [
    [
      { generatedCol: 0, sourceIndex: 0, sourceLine: 0, sourceCol: 0 },
      { generatedCol: 10, sourceIndex: 1, sourceLine: 5, sourceCol: 3 },
    ],
    [{ generatedCol: 0, sourceIndex: 0, sourceLine: 10, sourceCol: 0 }],
  ],
  ['/project/test/my-test.ts', '/project/node_modules/qunitx/assert.ts'],
);

module('Utils | source-map-decoder | lookupPosition', { concurrency: true }, () => {
  test('returns null for an out-of-range generated line', (assert) => {
    assert.strictEqual(lookupPosition(LOOKUP_DECODER, 99, 1), null);
  });

  test('returns null for line with no segments', (assert) => {
    const decoder = makeDecoder([[]], ['/src/a.ts']);
    assert.strictEqual(lookupPosition(decoder, 1, 1), null);
  });

  test('returns null when column precedes all segments', (assert) => {
    // gc=0 is the first segment; col=1 → col0=0 matches. col=0 → col0=-1 → no match.
    // But col is 1-based, so col=1 → col0=0. To test "before all", use a decoder
    // where the first segment has gc=5 and request col=1 (col0=0).
    const decoder = makeDecoder(
      [[{ generatedCol: 5, sourceIndex: 0, sourceLine: 0, sourceCol: 0 }]],
      ['/src/a.ts'],
    );
    assert.strictEqual(lookupPosition(decoder, 1, 1), null, 'col0=0 < gc=5, no match');
  });

  test('exact match: col lands exactly on a segment boundary', (assert) => {
    const result = lookupPosition(LOOKUP_DECODER, 1, 1); // col=1 → col0=0 → gc=0
    assert.notEqual(result, null);
    assert.strictEqual(result!.absolutePath, '/project/test/my-test.ts');
    assert.strictEqual(result!.line, 1); // sourceLine=0 → 1
    assert.strictEqual(result!.col, 1); // sourceCol=0 → 1
  });

  test('col within first segment (before gc=10)', (assert) => {
    const result = lookupPosition(LOOKUP_DECODER, 1, 5); // col0=4, matches gc=0
    assert.notEqual(result, null);
    assert.strictEqual(result!.absolutePath, '/project/test/my-test.ts');
  });

  test('col exactly on second segment boundary', (assert) => {
    const result = lookupPosition(LOOKUP_DECODER, 1, 11); // col=11 → col0=10 → gc=10
    assert.notEqual(result, null);
    assert.strictEqual(result!.absolutePath, '/project/node_modules/qunitx/assert.ts');
    assert.strictEqual(result!.line, 6); // sourceLine=5 → 6
    assert.strictEqual(result!.col, 4); // sourceCol=3 → 4
  });

  test('col past the last segment uses the last segment', (assert) => {
    const result = lookupPosition(LOOKUP_DECODER, 1, 999); // way past gc=10
    assert.notEqual(result, null);
    assert.strictEqual(result!.absolutePath, '/project/node_modules/qunitx/assert.ts');
  });

  test('line 2 maps to the correct source line', (assert) => {
    const result = lookupPosition(LOOKUP_DECODER, 2, 1);
    assert.notEqual(result, null);
    assert.strictEqual(result!.absolutePath, '/project/test/my-test.ts');
    assert.strictEqual(result!.line, 11); // sourceLine=10 → 11
  });

  test('resolves relative source paths against outDir', (assert) => {
    const decoder = makeDecoder(
      [[{ generatedCol: 0, sourceIndex: 0, sourceLine: 0, sourceCol: 0 }]],
      ['../src/test.ts'], // one level up from /project/tmp → /project/src/test.ts
      '/project/tmp',
    );
    const result = lookupPosition(decoder, 1, 1);
    assert.strictEqual(result!.absolutePath, '/project/src/test.ts');
  });

  test('resolves file:// sources by stripping the scheme', (assert) => {
    const decoder = makeDecoder(
      [[{ generatedCol: 0, sourceIndex: 0, sourceLine: 0, sourceCol: 0 }]],
      ['file:///abs/path/test.ts'],
      '/out',
    );
    assert.strictEqual(lookupPosition(decoder, 1, 1)!.absolutePath, '/abs/path/test.ts');
  });

  test('keeps absolute source paths as-is', (assert) => {
    const decoder = makeDecoder(
      [[{ generatedCol: 0, sourceIndex: 0, sourceLine: 0, sourceCol: 0 }]],
      ['/abs/src/test.ts'],
      '/out',
    );
    assert.strictEqual(lookupPosition(decoder, 1, 1)!.absolutePath, '/abs/src/test.ts');
  });

  test('binary search with 3 segments finds the correct middle segment', (assert) => {
    const decoder = makeDecoder(
      [
        [
          { generatedCol: 0, sourceIndex: 0, sourceLine: 0, sourceCol: 0 },
          { generatedCol: 5, sourceIndex: 0, sourceLine: 5, sourceCol: 0 },
          { generatedCol: 10, sourceIndex: 0, sourceLine: 10, sourceCol: 0 },
        ],
      ],
      ['/src/test.ts'],
    );
    // col=7 (col0=6) falls between gc=5 and gc=10 → uses gc=5 segment
    assert.strictEqual(lookupPosition(decoder, 1, 7)!.line, 6, 'middle position → middle segment');
    // col=1 (col0=0) exactly on gc=0 → first segment
    assert.strictEqual(lookupPosition(decoder, 1, 1)!.line, 1, 'first position → first segment');
    // col=11 (col0=10) exactly on gc=10 → last segment
    assert.strictEqual(lookupPosition(decoder, 1, 11)!.line, 11, 'last boundary → last segment');
  });

  test('sourceText is the trimmed source line from sourcesContent', (assert) => {
    const decoder = makeDecoder(
      [[{ generatedCol: 0, sourceIndex: 0, sourceLine: 1, sourceCol: 0 }]],
      ['/src/test.ts'],
      '/out',
      '',
      ['line 0\n  assert.strictEqual(x, 3);\nline 2'],
    );
    assert.strictEqual(lookupPosition(decoder, 1, 1)!.sourceText, 'assert.strictEqual(x, 3);');
  });

  test('sourceText is null when sourcesContent is absent', (assert) => {
    // LOOKUP_DECODER has no sourcesContent
    assert.strictEqual(lookupPosition(LOOKUP_DECODER, 1, 1)!.sourceText, null);
  });

  test('sourceText is null when the sourcesContent entry is null', (assert) => {
    const decoder = makeDecoder(
      [[{ generatedCol: 0, sourceIndex: 0, sourceLine: 0, sourceCol: 0 }]],
      ['/src/test.ts'],
      '/out',
      '',
      [null],
    );
    assert.strictEqual(lookupPosition(decoder, 1, 1)!.sourceText, null);
  });

  test('sourceText is null for a blank (whitespace-only) source line', (assert) => {
    const decoder = makeDecoder(
      [[{ generatedCol: 0, sourceIndex: 0, sourceLine: 1, sourceCol: 0 }]],
      ['/src/test.ts'],
      '/out',
      '',
      ['line 0\n   \nline 2'],
    );
    assert.strictEqual(lookupPosition(decoder, 1, 1)!.sourceText, null);
  });

  test('sourceText is null when sourceLine exceeds the content line count', (assert) => {
    const decoder = makeDecoder(
      [[{ generatedCol: 0, sourceIndex: 0, sourceLine: 99, sourceCol: 0 }]],
      ['/src/test.ts'],
      '/out',
      '',
      ['only one line'],
    );
    assert.strictEqual(lookupPosition(decoder, 1, 1)!.sourceText, null);
  });

  test('sourceRoot is prepended when resolving relative paths', (assert) => {
    // outDir=/project/tmp, sourceRoot=src, source=test.ts
    // → base = /project/tmp/src → absolutePath = /project/tmp/src/test.ts
    const decoder = makeDecoder(
      [[{ generatedCol: 0, sourceIndex: 0, sourceLine: 0, sourceCol: 0 }]],
      ['test.ts'],
      '/project/tmp',
      'src',
    );
    const result = lookupPosition(decoder, 1, 1);
    assert.strictEqual(result!.absolutePath, '/project/tmp/src/test.ts');
  });
});

// ── parseFrameLocation ─────────────────────────────────────────────────────────

module('Utils | source-map-decoder | parseFrameLocation', { concurrency: true }, () => {
  test('parses simple URL:LINE:COL', (assert) => {
    const r = parseFrameLocation('http://localhost:1234/tests.js:42:15');
    assert.deepEqual(r, { url: 'http://localhost:1234/tests.js', line: 42, col: 15 });
  });

  test('handles URL with port (multiple colons)', (assert) => {
    // The port colon must not be confused with line/col separators.
    const r = parseFrameLocation('http://localhost:9000/tests.js:100:5');
    assert.strictEqual(r!.url, 'http://localhost:9000/tests.js');
    assert.strictEqual(r!.line, 100);
    assert.strictEqual(r!.col, 5);
  });

  test('returns null for a string with no colon', (assert) => {
    assert.strictEqual(parseFrameLocation('nocolon'), null);
  });

  test('returns null when the last segment after colon is not numeric', (assert) => {
    assert.strictEqual(parseFrameLocation('file.js:foo:bar'), null);
  });

  test('returns null when only one colon-separated number is found', (assert) => {
    assert.strictEqual(parseFrameLocation('file.js:42'), null);
  });

  test('returns null for an empty string', (assert) => {
    assert.strictEqual(parseFrameLocation(''), null);
  });

  test('file:// URL is preserved in the url field', (assert) => {
    const r = parseFrameLocation('file:///home/user/tests.js:10:3');
    assert.strictEqual(r!.url, 'file:///home/user/tests.js');
    assert.strictEqual(r!.line, 10);
    assert.strictEqual(r!.col, 3);
  });
});

// ── isBundleUrl ────────────────────────────────────────────────────────────────

module('Utils | source-map-decoder | isBundleUrl', { concurrency: true }, () => {
  test('matches /tests.js', (assert) => {
    assert.true(isBundleUrl('http://localhost:1234/tests.js'));
  });

  test('matches /filtered-tests.js', (assert) => {
    assert.true(isBundleUrl('http://localhost:1234/filtered-tests.js'));
  });

  test('matches https scheme', (assert) => {
    assert.true(isBundleUrl('https://localhost:1234/tests.js'));
  });

  test('handles "async " prefix (Chrome async anonymous frames)', (assert) => {
    assert.true(isBundleUrl('async http://localhost:1234/tests.js'));
  });

  test('rejects a file:// URL', (assert) => {
    assert.false(isBundleUrl('file:///project/tests.js'));
  });

  test('rejects an unrelated http URL', (assert) => {
    assert.false(isBundleUrl('http://localhost:1234/app.js'));
  });

  test('rejects a URL that is just a filename without http', (assert) => {
    assert.false(isBundleUrl('tests.js'));
  });

  test('rejects a URL with tests.js in a path component but not at the end', (assert) => {
    assert.false(isBundleUrl('http://localhost:1234/tests.js/something'));
  });

  test('rejects eval frames that happen to contain tests.js', (assert) => {
    // "eval at <anonymous> (http://..." → url would be "eval at <anonymous> (http://..."
    // which does not start with http:// → false
    assert.false(isBundleUrl('eval at <anonymous> (http://localhost:1234/tests.js'));
  });

  test('matches group-prefixed tests.js URL (multi-group mode)', (assert) => {
    assert.true(isBundleUrl('http://localhost:1234/group-0/tests.js'));
  });
});

// ── resolveFrame ──────────────────────────────────────────────────────────────

// Decoder with two sources for resolveFrame/resolveStack tests:
//   Line 1: col 1-9 → user test file (sources[0]), col 10+ → node_modules (sources[1])
//   Line 2: col 1+  → user test file (sources[0])
const FRAME_DECODER = makeDecoder(
  [
    [
      { generatedCol: 0, sourceIndex: 0, sourceLine: 47, sourceCol: 4 },
      { generatedCol: 9, sourceIndex: 1, sourceLine: 200, sourceCol: 8 },
    ],
    [{ generatedCol: 0, sourceIndex: 0, sourceLine: 10, sourceCol: 2 }],
  ],
  ['/project/test/my-test.ts', '/project/node_modules/qunitx/assert.ts'],
  '/project/tmp',
);

module('Utils | source-map-decoder | resolveFrame', { concurrency: true }, () => {
  test('resolves Chrome named frame from test bundle', (assert) => {
    const r = resolveFrame(
      '    at Object.equal (http://localhost:1234/tests.js:1:1)',
      FRAME_DECODER,
      '/project',
    );
    assert.notEqual(r, null);
    assert.strictEqual(r!.resolved, '    at Object.equal (test/my-test.ts:48:5)');
    assert.strictEqual(r!.userPath, 'test/my-test.ts:48:5');
  });

  test('resolves Chrome named frame mapping to node_modules → userPath is null', (assert) => {
    const r = resolveFrame(
      '    at Object.equal (http://localhost:1234/tests.js:1:10)',
      FRAME_DECODER,
      '/project',
    );
    assert.notEqual(r, null);
    assert.strictEqual(r!.userPath, null, 'node_modules frame must not become firstUserFrame');
    assert.true(
      r!.resolved.includes('node_modules/qunitx/assert.ts'),
      'resolved includes node_modules path',
    );
  });

  test('resolves Chrome anonymous frame', (assert) => {
    const r = resolveFrame('    at http://localhost:1234/tests.js:2:1', FRAME_DECODER, '/project');
    assert.notEqual(r, null);
    assert.strictEqual(r!.resolved, '    at test/my-test.ts:11:3');
    assert.strictEqual(r!.userPath, 'test/my-test.ts:11:3');
  });

  test('resolves Chrome async anonymous frame', (assert) => {
    const r = resolveFrame(
      '    at async http://localhost:1234/tests.js:2:1',
      FRAME_DECODER,
      '/project',
    );
    assert.notEqual(r, null);
    assert.true(r!.resolved.includes('async test/my-test.ts:'), 'resolved includes async prefix');
  });

  test('resolves Firefox/WebKit frame', (assert) => {
    const r = resolveFrame(
      'Object.equal@http://localhost:1234/tests.js:1:1',
      FRAME_DECODER,
      '/project',
    );
    assert.notEqual(r, null);
    assert.strictEqual(r!.resolved, 'Object.equal@test/my-test.ts:48:5');
    assert.strictEqual(r!.userPath, 'test/my-test.ts:48:5');
  });

  test('returns null for a frame not from a bundle URL', (assert) => {
    const r = resolveFrame(
      '    at Object.equal (http://localhost:1234/app.js:1:1)',
      FRAME_DECODER,
      '/project',
    );
    assert.strictEqual(r, null);
  });

  test('returns null for a native code frame', (assert) => {
    const r = resolveFrame('    at async Promise.all (index 0)', FRAME_DECODER, '/project');
    assert.strictEqual(r, null);
  });

  test('returns null for an unrecognised frame format', (assert) => {
    const r = resolveFrame('Error: something went wrong', FRAME_DECODER, '/project');
    assert.strictEqual(r, null);
  });

  test('returns null when lookupPosition finds no mapping', (assert) => {
    // Line 999 has no segments in FRAME_DECODER.
    const r = resolveFrame(
      '    at Object.x (http://localhost:1234/tests.js:999:1)',
      FRAME_DECODER,
      '/project',
    );
    assert.strictEqual(r, null);
  });

  test('preserves full absolutePath when source is outside projectRoot', (assert) => {
    const decoder = makeDecoder(
      [[{ generatedCol: 0, sourceIndex: 0, sourceLine: 0, sourceCol: 0 }]],
      ['/other/project/test.ts'],
      '/out',
    );
    const r = resolveFrame(
      '    at fn (http://localhost:1234/tests.js:1:1)',
      decoder,
      '/my/project', // different from source root
    );
    assert.notEqual(r, null);
    assert.true(
      r!.resolved.includes('/other/project/test.ts'),
      'resolved includes absolute path outside project',
    );
  });

  test('filtered-tests.js URL is also resolved', (assert) => {
    const r = resolveFrame(
      '    at fn (http://localhost:1234/filtered-tests.js:1:1)',
      FRAME_DECODER,
      '/project',
    );
    assert.notEqual(r, null, 'filtered-tests.js must be treated as a bundle URL');
  });
});

// ── resolveStack ──────────────────────────────────────────────────────────────

module('Utils | source-map-decoder | resolveStack', { concurrency: true }, () => {
  test('resolves all bundle frames and returns firstUserFrame', (assert) => {
    const stack = [
      '    at Object.equal (http://localhost:1234/tests.js:1:10)', // node_modules
      '    at Object.<anonymous> (http://localhost:1234/tests.js:1:1)', // user code
    ].join('\n');

    const { resolvedStack, firstUserFrame } = resolveStack(stack, FRAME_DECODER, '/project');

    assert.true(
      resolvedStack.includes('node_modules/qunitx/assert.ts'),
      'node_modules frame resolved',
    );
    assert.true(resolvedStack.includes('test/my-test.ts'), 'user frame resolved');
    assert.strictEqual(
      firstUserFrame,
      'test/my-test.ts:48:5',
      'first user frame skips node_modules',
    );
  });

  test('firstUserFrame skips all node_modules frames and picks first user frame', (assert) => {
    const stack = [
      '    at assert.ok (http://localhost:1234/tests.js:1:10)', // node_modules (col=10, gc=9)
      '    at assert.equal (http://localhost:1234/tests.js:1:10)', // node_modules again
      '    at myTest (http://localhost:1234/tests.js:1:1)', // user code (col=1, gc=0)
    ].join('\n');

    const { firstUserFrame } = resolveStack(stack, FRAME_DECODER, '/project');
    assert.strictEqual(firstUserFrame, 'test/my-test.ts:48:5');
  });

  test('non-bundle frames are left unchanged', (assert) => {
    const nativeFrame = '    at async Promise.all (index 0)';
    const { resolvedStack } = resolveStack(nativeFrame, FRAME_DECODER, '/project');
    assert.strictEqual(resolvedStack, nativeFrame, 'native frame must not be modified');
  });

  test('Error prefix line is left unchanged', (assert) => {
    const stack =
      'Error: Expected 1 to equal 2\n    at Object.equal (http://localhost:1234/tests.js:1:1)';
    const { resolvedStack } = resolveStack(stack, FRAME_DECODER, '/project');
    assert.true(resolvedStack.startsWith('Error: Expected 1 to equal 2\n'));
  });

  test('returns null firstUserFrame when all frames are from node_modules', (assert) => {
    const stack = '    at assert.ok (http://localhost:1234/tests.js:1:10)'; // maps to node_modules
    const { firstUserFrame } = resolveStack(stack, FRAME_DECODER, '/project');
    assert.strictEqual(firstUserFrame, null);
  });

  test('returns null firstUserFrame when stack has no bundle frames', (assert) => {
    const { firstUserFrame } = resolveStack('    at native code', FRAME_DECODER, '/project');
    assert.strictEqual(firstUserFrame, null);
  });

  test('empty stack returns empty resolvedStack and null firstUserFrame', (assert) => {
    const { resolvedStack, firstUserFrame } = resolveStack('', FRAME_DECODER, '/project');
    assert.strictEqual(resolvedStack, '');
    assert.strictEqual(firstUserFrame, null);
  });

  test('Firefox/WebKit frames are resolved in full stack', (assert) => {
    const stack = [
      'assert.equal@http://localhost:1234/tests.js:1:10', // node_modules
      '<anonymous>@http://localhost:1234/tests.js:1:1', // user code
    ].join('\n');

    const { resolvedStack, firstUserFrame } = resolveStack(stack, FRAME_DECODER, '/project');
    assert.true(
      resolvedStack.includes('node_modules/qunitx/assert.ts'),
      'node_modules frame resolved',
    );
    assert.true(resolvedStack.includes('test/my-test.ts'), 'user frame resolved');
    assert.strictEqual(firstUserFrame, 'test/my-test.ts:48:5');
  });

  test('mixed Chrome and native frames: only bundle frames are resolved', (assert) => {
    const stack = [
      '    at Object.equal (http://localhost:1234/tests.js:1:1)',
      '    at async Promise.all (index 0)',
      '    at processTicksAndRejections (node:internal/process/task_queues:96:5)',
    ].join('\n');

    const { resolvedStack } = resolveStack(stack, FRAME_DECODER, '/project');
    const lines = resolvedStack.split('\n');
    assert.true(lines[0].includes('test/my-test.ts'), 'bundle frame resolved');
    assert.strictEqual(lines[1], '    at async Promise.all (index 0)', 'native unchanged');
    assert.true(lines[2].includes('node:internal'), 'node: frame unchanged');
  });

  test('path is made relative to projectRoot when inside the project', (assert) => {
    const { firstUserFrame } = resolveStack(
      '    at fn (http://localhost:1234/tests.js:1:1)',
      FRAME_DECODER,
      '/project',
    );
    assert.false(firstUserFrame!.startsWith('/'), 'must not be absolute path');
    assert.strictEqual(firstUserFrame, 'test/my-test.ts:48:5');
  });

  test('firstUserSourceText is the trimmed source line of the first user frame', (assert) => {
    const lines = Array.from({ length: 50 }, (_, i) => `  source line ${i}`);
    lines[47] = '  assert.strictEqual(x, 3);';
    const decoder = makeDecoder(
      [[{ generatedCol: 0, sourceIndex: 0, sourceLine: 47, sourceCol: 4 }]],
      ['/project/test/my-test.ts'],
      '/project/tmp',
      '',
      [lines.join('\n')],
    );
    const { firstUserFrame, firstUserSourceText } = resolveStack(
      '    at fn (http://localhost:1234/tests.js:1:1)',
      decoder,
      '/project',
    );
    assert.strictEqual(firstUserFrame, 'test/my-test.ts:48:5');
    assert.strictEqual(firstUserSourceText, 'assert.strictEqual(x, 3);');
  });

  test('firstUserSourceText is null when decoder has no sourcesContent', (assert) => {
    const { firstUserSourceText } = resolveStack(
      '    at fn (http://localhost:1234/tests.js:1:1)',
      FRAME_DECODER,
      '/project',
    );
    assert.strictEqual(firstUserSourceText, null);
  });

  test('firstUserSourceText skips node_modules frames and picks the first user frame text', (assert) => {
    const userLine = 'assert.deepEqual(a, b);';
    const lines = Array.from({ length: 50 }, (_, i) => `  line ${i}`);
    lines[47] = `  ${userLine}`;
    const decoder = makeDecoder(
      [
        [
          { generatedCol: 0, sourceIndex: 0, sourceLine: 47, sourceCol: 4 }, // user (col 1)
          { generatedCol: 9, sourceIndex: 1, sourceLine: 200, sourceCol: 8 }, // node_modules (col 10)
        ],
      ],
      ['/project/test/my-test.ts', '/project/node_modules/qunitx/assert.ts'],
      '/project/tmp',
      '',
      [lines.join('\n'), null],
    );
    const stack = [
      '    at assert.ok (http://localhost:1234/tests.js:1:10)', // node_modules
      '    at myTest (http://localhost:1234/tests.js:1:1)', // user code
    ].join('\n');
    const { firstUserSourceText } = resolveStack(stack, decoder, '/project');
    assert.strictEqual(firstUserSourceText, userLine);
  });

  test('full integration: extractInlineSourceMap + resolveStack with sourcesContent', (assert) => {
    const mapJson = {
      version: 3,
      sources: ['../test/integration.ts', '../node_modules/lib/assert.ts'],
      sourceRoot: '',
      mappings: 'AAAA', // gc=0 → si=0, sl=0, sc=0
      sourcesContent: ['assert.strictEqual(result, 42);', null],
    };
    const bundle = bundleWithInlineMap(mapJson);
    const decoder = extractInlineSourceMap(bundle, '/project/tmp');

    assert.notEqual(decoder, null, 'decoder must be extracted');

    const stack = '    at fn (http://localhost:1234/tests.js:1:1)';
    const { resolvedStack, firstUserFrame, firstUserSourceText } = resolveStack(
      stack,
      decoder!,
      '/project',
    );

    assert.true(
      resolvedStack.includes('test/integration.ts:1:1'),
      'resolved stack contains original source path',
    );
    assert.strictEqual(firstUserFrame, 'test/integration.ts:1:1');
    assert.strictEqual(firstUserSourceText, 'assert.strictEqual(result, 42);');
  });
});
