#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run
/**
 * Benchmark regression checker for qunitx-cli.
 *
 * Modes
 * -----
 * Default (stdin)
 *   Reads `deno bench --json` output from stdin, compares each benchmark's
 *   average nanoseconds against the stored baseline in benches/results.json.
 *   A result is a regression only when BOTH conditions hold:
 *     1. percentage increase > effective threshold
 *     2. absolute delta > MIN_ABS_DELTA_NS (guards sub-µs JIT/GC noise)
 *
 * --files <file> [file…]   (recommended)
 *   Runs each bench file in an isolated subprocess so that GC pressure from
 *   one group (e.g. esbuild I/O heap churn) cannot inflate latencies in
 *   another (server port-binding, TAP rendering). Combines the per-file JSON
 *   before checking. Tighter multipliers are safe because cross-file GC
 *   interference is eliminated.
 *
 * --save
 *   Saves the measured values as the new baseline instead of checking.
 *
 * Environment variables
 * ---------------------
 *   REGRESSION_THRESHOLD  percent threshold (default 26)
 *   MIN_ABS_DELTA_NS      absolute delta floor in nanoseconds (default 1000 = 1µs)
 *   SKIP_BENCHMARK        comma-separated bench-file basenames to skip (without
 *                         `.bench.ts`).  Special values `true|1|all` short-circuit
 *                         the whole gate.  Useful when laptop load makes spawn-
 *                         based benches falsely regress; CI keeps the strict gate.
 *                         Examples:
 *                           SKIP_BENCHMARK=true         # skip everything
 *                           SKIP_BENCHMARK=e2e          # skip benches/e2e.bench.ts
 *                           SKIP_BENCHMARK=e2e,tap      # skip multiple files
 *
 * Usage
 * -----
 *   # isolated (preferred):
 *   deno run --allow-all scripts/check-benchmarks.ts \
 *     --files benches/esbuild.bench.ts benches/server.bench.ts ...
 *
 *   # pipe-based (legacy):
 *   deno bench --allow-all --json benches/*.bench.ts \
 *     | deno run --allow-all scripts/check-benchmarks.ts
 *
 *   # save new baseline:
 *   deno run --allow-all scripts/check-benchmarks.ts --save \
 *     --files benches/esbuild.bench.ts ...
 */

import { bold, red, green, yellow, dim, gray } from "jsr:@std/fmt/colors";

const BASELINE_FILE = new URL("../benches/results.json", import.meta.url).pathname;

interface BenchResult {
  name: string;
  avg: number; // nanoseconds
}

interface DenoJsonOutput {
  version: number;
  benches: Array<{
    name: string;
    results: Array<{ ok?: { avg: number } }>;
    [key: string]: unknown;
  }>;
}

interface Baseline {
  savedAt: string;
  results: Record<string, number>; // bench name → avg nanoseconds
}

// ─── I/O helpers ─────────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  return new Response(Deno.stdin.readable).text();
}

/** Runs a single bench file in an isolated subprocess and returns its parsed results. */
async function runBenchFile(file: string): Promise<BenchResult[]> {
  const cmd = new Deno.Command("deno", {
    args: ["bench", "--allow-all", "--json", file],
    stdout: "piped",
    stderr: "inherit",
  });
  const { code, stdout } = await cmd.output();
  if (code !== 0) Deno.exit(code);
  return parseResults(new TextDecoder().decode(stdout));
}

/**
 * Merges two result sets by per-benchmark min — system noise only ever inflates
 * timings, so the minimum across runs is the most deterministic measurement of
 * intrinsic cost.  Names present in only one side are kept as-is.
 */
function mergeMin(a: BenchResult[], b: BenchResult[]): BenchResult[] {
  const byName = new Map(a.map((r) => [r.name, r.avg]));
  for (const { name, avg } of b) {
    const prev = byName.get(name);
    byName.set(name, prev !== undefined ? Math.min(prev, avg) : avg);
  }
  return Array.from(byName, ([name, avg]) => ({ name, avg }));
}

/**
 * Best-of-2 across files. Used when establishing a baseline (--save) or when no
 * baseline exists yet, so the saved numbers are not biased by a single spike.
 */
async function collectBestOf2(files: string[]): Promise<BenchResult[]> {
  const all: BenchResult[] = [];
  for (const file of files) {
    const runA = await runBenchFile(file);
    const runB = await runBenchFile(file);
    all.push(...mergeMin(runA, runB));
  }
  return all;
}

/**
 * Adaptive collection for --check: each file runs once, and only files whose
 * benchmarks would regress against the baseline are retried (up to MAX_ATTEMPTS
 * total runs, taking the per-benchmark min).  In the happy case this is ~half
 * the wall-clock of best-of-2; in the noisy case it self-stabilises by gathering
 * more samples for exactly the benches that need them.
 */
async function collectAdaptive(
  files: string[],
  baseline: Baseline,
  thresholdPct: number,
  minAbsDeltaNs: number,
): Promise<BenchResult[]> {
  const MAX_ATTEMPTS = 3;
  const threshold = thresholdPct / 100;
  const all: BenchResult[] = [];
  for (const file of files) {
    let results = await runBenchFile(file);
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      const stillRegressing = results.some(({ name, avg }) => {
        const saved = baseline.results[name];
        return saved !== undefined && isRegression(avg, saved, threshold, minAbsDeltaNs);
      });
      if (!stillRegressing) break;
      results = mergeMin(results, await runBenchFile(file));
    }
    all.push(...results);
  }
  return all;
}

/**
 * Resolve and apply SKIP_BENCHMARK.  Returns the file list to run; exits 0 if
 * the user asked to skip everything.  File matching is by basename minus the
 * `.bench.ts` suffix, so SKIP_BENCHMARK=e2e picks `benches/e2e.bench.ts`.
 */
function applySkipBenchmark(files: string[]): string[] {
  const raw = (Deno.env.get("SKIP_BENCHMARK") ?? "").trim();
  if (!raw) return files;

  if (["true", "1", "all"].includes(raw.toLowerCase())) {
    console.log(yellow(`SKIP_BENCHMARK=${raw} → skipping all benchmark checks`));
    Deno.exit(0);
  }

  const skipNames = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const remaining = files.filter((f) => {
    const base = f.replace(/^.*\//, "").replace(/\.bench\.ts$/, "");
    return !skipNames.includes(base);
  });
  const skipped = files.filter((f) => !remaining.includes(f));
  if (skipped.length > 0) {
    const names = skipped.map((f) => f.replace(/^.*\//, "")).join(", ");
    console.log(dim(`Skipping bench files via SKIP_BENCHMARK: ${names}`));
  }
  return remaining;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

function parseResults(raw: string): BenchResult[] {
  let parsed: DenoJsonOutput;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("check-benchmarks: failed to parse JSON from stdin.");
    console.error("Make sure you piped the output of: deno bench --json ...");
    Deno.exit(1);
  }

  if (!Array.isArray(parsed.benches)) {
    console.error("check-benchmarks: unexpected JSON shape (missing .benches array).");
    Deno.exit(1);
  }

  return parsed.benches.flatMap((b) => {
    const avg = b.results?.[0]?.ok?.avg;
    if (avg === undefined) return [];
    return [{ name: b.name, avg }];
  });
}

// ─── Threshold logic ─────────────────────────────────────────────────────────

// Observed variance after best-of-2 + process isolation, measured post-test-suite load:
//   < 1ms       2×  TAP/server: sub-ms GC pauses in a Deno subprocess still spike ~44%
//   1ms–100ms   1×  esbuild: stable I/O, < 14% variance — flat threshold applies directly
//   100ms–500ms 2.5× process-spawn (cli startup): OS fork/exec jitter reaches ~58%
//   ≥ 500ms     1×  e2e: stable with best-of-2, < 14% variance — flat threshold applies
// Sub-µs benchmarks are additionally guarded by the MIN_ABS_DELTA_NS absolute floor.
// Sustained background load (e.g. running on a busy laptop) can push transient noise
// well above these thresholds; collectAdaptive retries up to 3× on regression to
// resample, and SKIP_BENCHMARK is the escape hatch for sustained noise.
const SUB_MS_NS   =   1_000_000;  //   1 ms
const SPAWN_LO_NS = 100_000_000;  // 100 ms
const SPAWN_HI_NS = 500_000_000;  // 500 ms

function effectiveThreshold(saved: number, threshold: number): number {
  if (saved < SUB_MS_NS) return threshold * 2;
  if (saved >= SPAWN_LO_NS && saved < SPAWN_HI_NS) return threshold * 2.5;
  return threshold;
}

function isRegression(avg: number, saved: number, threshold: number, minAbsDeltaNs: number): boolean {
  if (avg - saved <= minAbsDeltaNs) return false; // absolute floor: ignore JIT/GC noise
  return (avg - saved) / saved > effectiveThreshold(saved, threshold);
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function fmtNs(ns: number): string {
  if (ns >= 1_000_000_000) return `${(ns / 1_000_000_000).toFixed(2)}s`;
  if (ns >= 1_000_000)     return `${(ns / 1_000_000).toFixed(2)}ms`;
  if (ns >= 1_000)         return `${(ns / 1_000).toFixed(2)}µs`;
  return `${ns.toFixed(0)}ns`;
}

function fmtChange(change: number, threshold: number): string {
  const arrow = change > 0 ? "▲" : "▼";
  const pct = `${arrow}${(Math.abs(change) * 100).toFixed(1)}%`;
  if (change > threshold) return bold(red(pct));
  if (change > threshold / 2) return yellow(pct);
  if (change < 0) return green(pct);
  return dim(pct);
}

function printTable(
  results: BenchResult[],
  baseline: Baseline | null,
  threshold: number,
  minAbsDeltaNs: number,
): void {
  const hasBaseline = baseline !== null;
  const header = "  " + bold("Name".padEnd(52)) + bold("avg".padStart(12)) +
    (hasBaseline ? bold("Baseline".padStart(12)) + bold("Change".padStart(10)) : "");
  console.log("\n" + header);
  console.log(gray("  " + "─".repeat(hasBaseline ? 86 : 64)));

  for (const { name, avg } of results) {
    const saved = baseline?.results[name];
    if (!hasBaseline || saved === undefined) {
      console.log(`  ${yellow("NEW ")} ${name.padEnd(52)}${fmtNs(avg).padStart(12)}`);
      continue;
    }
    const change = (avg - saved) / saved;
    const t = effectiveThreshold(saved, threshold);
    const fail = isRegression(avg, saved, threshold, minAbsDeltaNs);
    const flag = fail ? bold(red(" FAIL")) : "     ";
    console.log(
      `${flag} ${name.padEnd(52)}${fmtNs(avg).padStart(12)}${dim(fmtNs(saved).padStart(12))}${fmtChange(change, t).padStart(10)}`,
    );
  }
  console.log();
}

// ─── Save / Check ─────────────────────────────────────────────────────────────

async function loadBaseline(): Promise<Baseline | null> {
  try {
    return JSON.parse(await Deno.readTextFile(BASELINE_FILE));
  } catch {
    return null;
  }
}

async function save(
  results: BenchResult[],
  existing: Baseline | null,
  minAbsDeltaNs: number,
): Promise<void> {
  printTable(results, existing, 0.26, minAbsDeltaNs);

  const baseline: Baseline = {
    savedAt: new Date().toISOString(),
    results: Object.fromEntries(results.map((r) => [r.name, r.avg])),
  };
  await Deno.writeTextFile(BASELINE_FILE, JSON.stringify(baseline, null, 2) + "\n");
  console.log(green(`Baseline saved: ${results.length} benchmark(s) → benches/results.json`));
}

async function check(
  results: BenchResult[],
  baseline: Baseline | null,
  thresholdPct: number,
  minAbsDeltaNs: number,
): Promise<boolean> {
  const threshold = thresholdPct / 100;
  if (!baseline) {
    console.log(yellow("No baseline found in benches/results.json."));
    console.log(dim("Run 'make bench' once to establish one, then re-run."));
    printTable(results, null, threshold, minAbsDeltaNs);
    return true; // don't fail on first-ever run
  }

  console.log(`\nBenchmark regression check (threshold: ${yellow(`${thresholdPct}%`)}, abs floor: ${yellow(fmtNs(minAbsDeltaNs))})`);
  printTable(results, baseline, threshold, minAbsDeltaNs);

  const failures = results.filter(({ name, avg }) => {
    const saved = baseline.results[name];
    if (saved === undefined) return false;
    return isRegression(avg, saved, threshold, minAbsDeltaNs);
  });

  if (failures.length > 0) {
    console.error(bold(red(`Regressions exceeding ${thresholdPct}% threshold:`)));
    for (const { name, avg } of failures) {
      const saved = baseline.results[name];
      console.error(red(`  FAIL  ${name}: ${fmtNs(saved)} → ${fmtNs(avg)}`));
    }
    console.error(
      dim(
        `\nIf this is laptop-load noise (e.g. different benches fail across runs), retry on an idle\n` +
          `machine, refresh the baseline with 'make bench-update', or set SKIP_BENCHMARK=true|<file>\n` +
          `to bypass the gate for this run.`,
      ),
    );
    return false;
  }

  console.log(green(`All ${results.length} benchmark(s) within threshold.`));
  return true;
}

// ─── main ────────────────────────────────────────────────────────────────────

const isSave = Deno.args.includes("--save");
const filesIdx = Deno.args.indexOf("--files");
const minAbsDeltaNs = Number(Deno.env.get("MIN_ABS_DELTA_NS") ?? "1000");
const thresholdPct = parseFloat(Deno.env.get("REGRESSION_THRESHOLD") ?? "26");
const baseline = await loadBaseline();

let results: BenchResult[];
if (filesIdx !== -1) {
  const allFiles = Deno.args.slice(filesIdx + 1).filter((a) => !a.startsWith("--"));
  const files = applySkipBenchmark(allFiles);
  if (files.length === 0) {
    console.log(yellow("All bench files skipped via SKIP_BENCHMARK; nothing to do."));
    Deno.exit(0);
  }
  // --check with a baseline → adaptive (1 run, retry only on regression).
  // --save or no baseline → best-of-2 so the saved numbers aren't biased by a single spike.
  results = !isSave && baseline
    ? await collectAdaptive(files, baseline, thresholdPct, minAbsDeltaNs)
    : await collectBestOf2(files);
} else {
  results = parseResults(await readStdin());
}

if (isSave) {
  await save(results, baseline, minAbsDeltaNs);
} else {
  const ok = await check(results, baseline, thresholdPct, minAbsDeltaNs);
  if (!ok) Deno.exit(1);
}
