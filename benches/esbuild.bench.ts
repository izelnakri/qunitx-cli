/**
 * Benchmarks esbuild bundling performance at different project sizes.
 * This measures the most CPU-intensive part of each test run — the bundle phase.
 *
 * Two groups:
 *   esbuild-fresh       — esbuild.build() from scratch (non-watch path)
 *   esbuild-incremental — esbuild.context() + context.rebuild() (watch-mode path)
 *
 * Fixtures import from `qunitx` so the module graph is realistic: esbuild must
 * resolve and bundle qunitx + its vendored deps (~270 KB). Incremental contexts
 * keep that graph warm across rebuilds, skipping re-parse of unchanged modules.
 *
 * Incremental contexts are created and warmed at module level (one initial build
 * each) so each bench iteration measures true steady-state rebuild cost — the
 * 2nd+ save in watch mode, after the module graph is already hot.
 */
import esbuild from "esbuild";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname;
// Fixtures must live inside the project tree so Node's module resolution can find `qunitx`
// by walking up to the project's node_modules. /tmp would have no node_modules to find.
const FIXTURE_DIR = join(PROJECT_ROOT, "tmp", "bench-esbuild-fixtures");
await rm(FIXTURE_DIR, { recursive: true, force: true });
await mkdir(FIXTURE_DIR, { recursive: true });

// Generate fixture test files that import from qunitx — matches what real test suites
// look like. esbuild must resolve + bundle qunitx and its vendored dependencies on each
// fresh build; incremental rebuild reuses the cached module graph for unchanged deps.
const ALL_PATHS: string[] = [];
for (let i = 0; i < 30; i++) {
  const filePath = join(FIXTURE_DIR, `fixture-${i}.ts`);
  await writeFile(filePath, [
    `import { module, test } from 'qunitx';`,
    `module('Fixture ${i}', function() {`,
    `  test('fixture test ${i}a', function(assert) { assert.ok(true); });`,
    `  test('fixture test ${i}b', function(assert) { assert.ok(true); });`,
    `});`,
  ].join("\n"));
  ALL_PATHS.push(filePath);
}

const PATHS_3  = ALL_PATHS.slice(0, 3);
const PATHS_10 = ALL_PATHS.slice(0, 10);
const PATHS_30 = ALL_PATHS;

function buildOptions(paths: string[]): esbuild.BuildOptions {
  return {
    stdin: {
      contents: paths.map((p) => `import "${p}";`).join("\n"),
      resolveDir: FIXTURE_DIR,
    },
    bundle: true,
    write: false,
    keepNames: true,
    legalComments: "none",
    logLevel: "silent",
  };
}

function bundle(paths: string[]) {
  return esbuild.build(buildOptions(paths));
}

// ─── fresh build ─────────────────────────────────────────────────────────────
Deno.bench("esbuild: fresh build, 3 test files", {
  group: "esbuild-fresh",
  baseline: true,
}, async () => {
  await bundle(PATHS_3);
});

Deno.bench("esbuild: fresh build, 10 test files", {
  group: "esbuild-fresh",
}, async () => {
  await bundle(PATHS_10);
});

Deno.bench("esbuild: fresh build, 30 test files", {
  group: "esbuild-fresh",
}, async () => {
  await bundle(PATHS_30);
});

// ─── incremental rebuild (watch mode) ────────────────────────────────────────
// Contexts are warmed with one initial rebuild before any bench iteration runs.
// Each iteration calls rebuild() with an unchanged input set — simulating a
// file-content save (where the file list stays the same, only contents change).
// esbuild re-reads changed files but skips re-parsing the qunitx module graph.
const [ctx3, ctx10, ctx30] = await Promise.all([
  esbuild.context(buildOptions(PATHS_3)),
  esbuild.context(buildOptions(PATHS_10)),
  esbuild.context(buildOptions(PATHS_30)),
]);
await Promise.all([ctx3.rebuild(), ctx10.rebuild(), ctx30.rebuild()]);

Deno.bench("esbuild: incremental rebuild, 3 test files", {
  group: "esbuild-incremental",
  baseline: true,
}, async () => {
  await ctx3.rebuild();
});

Deno.bench("esbuild: incremental rebuild, 10 test files", {
  group: "esbuild-incremental",
}, async () => {
  await ctx10.rebuild();
});

Deno.bench("esbuild: incremental rebuild, 30 test files", {
  group: "esbuild-incremental",
}, async () => {
  await ctx30.rebuild();
});

globalThis.addEventListener("unload", async () => {
  await Promise.all([ctx3.dispose(), ctx10.dispose(), ctx30.dispose()]);
  await esbuild.stop();
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});
