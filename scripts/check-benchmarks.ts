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
 * Collects results from one or more bench files, each in its own isolated process.
 * Each file is run twice and the per-benchmark minimum avg is kept so that a
 * single-run GC/JIT spike cannot inflate either the baseline or the check value.
 */
async function collectIsolated(files: string[]): Promise<BenchResult[]> {
  const all: BenchResult[] = [];
  for (const file of files) {
    const runA = await runBenchFile(file);
    const runB = await runBenchFile(file);
    const byName = new Map(runA.map((r) => [r.name, r.avg]));
    for (const { name, avg } of runB) {
      const prev = byName.get(name);
      byName.set(name, prev !== undefined ? Math.min(prev, avg) : avg);
    }
    for (const [name, avg] of byName) {
      all.push({ name, avg });
    }
  }
  return all;
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

async function save(results: BenchResult[], minAbsDeltaNs: number): Promise<void> {
  let existing: Baseline | null = null;
  try {
    existing = JSON.parse(await Deno.readTextFile(BASELINE_FILE));
  } catch { /* no prior baseline */ }

  printTable(results, existing, 0.26, minAbsDeltaNs);

  const baseline: Baseline = {
    savedAt: new Date().toISOString(),
    results: Object.fromEntries(results.map((r) => [r.name, r.avg])),
  };
  await Deno.writeTextFile(BASELINE_FILE, JSON.stringify(baseline, null, 2) + "\n");
  console.log(green(`Baseline saved: ${results.length} benchmark(s) → benches/results.json`));
}

async function check(results: BenchResult[], thresholdPct: number, minAbsDeltaNs: number): Promise<boolean> {
  const threshold = thresholdPct / 100;
  let baseline: Baseline | null = null;
  try {
    baseline = JSON.parse(await Deno.readTextFile(BASELINE_FILE));
  } catch {
    console.log(yellow("No baseline found in benches/results.json."));
    console.log(dim("Run 'make bench' once to establish one, then re-run."));
    printTable(results, null, threshold, minAbsDeltaNs);
    return true; // don't fail on first-ever run
  }

  console.log(`\nBenchmark regression check (threshold: ${yellow(`${thresholdPct}%`)}, abs floor: ${yellow(fmtNs(minAbsDeltaNs))})`);
  printTable(results, baseline, threshold, minAbsDeltaNs);

  const failures = results.filter(({ name, avg }) => {
    const saved = baseline!.results[name];
    if (saved === undefined) return false;
    return isRegression(avg, saved, threshold, minAbsDeltaNs);
  });

  if (failures.length > 0) {
    console.error(bold(red(`Regressions exceeding ${thresholdPct}% threshold:`)));
    for (const { name, avg } of failures) {
      const saved = baseline.results[name];
      console.error(red(`  FAIL  ${name}: ${fmtNs(saved)} → ${fmtNs(avg)}`));
    }
    return false;
  }

  console.log(green(`All ${results.length} benchmark(s) within threshold.`));
  return true;
}

// ─── main ────────────────────────────────────────────────────────────────────

const isSave = Deno.args.includes("--save");
const filesIdx = Deno.args.indexOf("--files");
const minAbsDeltaNs = Number(Deno.env.get("MIN_ABS_DELTA_NS") ?? "1000");

let results: BenchResult[];
if (filesIdx !== -1) {
  const files = Deno.args.slice(filesIdx + 1).filter((a) => !a.startsWith("--"));
  results = await collectIsolated(files);
} else {
  results = parseResults(await readStdin());
}

if (isSave) {
  await save(results, minAbsDeltaNs);
} else {
  const threshold = parseFloat(Deno.env.get("REGRESSION_THRESHOLD") ?? "26");
  const ok = await check(results, threshold, minAbsDeltaNs);
  if (!ok) Deno.exit(1);
}
