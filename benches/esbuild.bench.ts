/**
 * Benchmarks esbuild bundling performance at different project sizes.
 * This measures the most CPU-intensive part of each test run — the bundle phase.
 */
import esbuild from "esbuild";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const FIXTURE_DIR = join(tmpdir(), "qunitx-bench-esbuild");
await rm(FIXTURE_DIR, { recursive: true, force: true });
await mkdir(FIXTURE_DIR, { recursive: true });

// Generate self-contained JS fixture files (no external deps needed).
// Each file exports a few functions — representative of a small test module.
const ALL_PATHS: string[] = [];
for (let i = 0; i < 30; i++) {
  const filePath = join(FIXTURE_DIR, `fixture-${i}.js`);
  await writeFile(filePath, [
    `export function run_${i}_a() { return "result-a-${i}"; }`,
    `export function run_${i}_b() { return "result-b-${i}"; }`,
    `export function run_${i}_c() { const x = [run_${i}_a(), run_${i}_b()]; return x; }`,
    `export default run_${i}_c();`,
  ].join("\n"));
  ALL_PATHS.push(filePath);
}

const PATHS_3  = ALL_PATHS.slice(0, 3);
const PATHS_10 = ALL_PATHS.slice(0, 10);
const PATHS_30 = ALL_PATHS;

function bundle(paths: string[]) {
  return esbuild.build({
    stdin: {
      contents: paths.map((p) => `import "${p}";`).join("\n"),
      resolveDir: FIXTURE_DIR,
    },
    bundle: true,
    write: false,      // skip disk I/O — measure pure bundling cost
    logLevel: "silent",
  });
}

// baseline = the cheapest variant; others show cost relative to it
Deno.bench("esbuild: bundle 3 test files", {
  group: "esbuild",
  baseline: true,

}, async () => {
  await bundle(PATHS_3);
});

Deno.bench("esbuild: bundle 10 test files", {
  group: "esbuild",

}, async () => {
  await bundle(PATHS_10);
});

Deno.bench("esbuild: bundle 30 test files", {
  group: "esbuild",

}, async () => {
  await bundle(PATHS_30);
});

globalThis.addEventListener("unload", async () => {
  await esbuild.stop();
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});
