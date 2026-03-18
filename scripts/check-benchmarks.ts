#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Benchmark regression checker for qunitx-cli.
 *
 * Modes
 * -----
 * Default (no flags)
 *   Reads `deno bench --json` output from stdin, compares each benchmark's
 *   average nanoseconds against the stored baseline in benches/results.json.
 *   Exits 1 if any benchmark regressed more than REGRESSION_THRESHOLD percent
 *   (default 20).
 *
 * --save
 *   Reads `deno bench --json` output from stdin, prints the results table,
 *   then saves to benches/results.json as the new baseline.
 *
 * Usage
 * -----
 *   deno bench --allow-all --json benches/esbuild.bench.ts ... \
 *     | deno run --allow-all scripts/check-benchmarks.ts
 *
 *   # save new baseline
 *   ... | deno run --allow-all scripts/check-benchmarks.ts --save
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

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Deno.stdin.readable) {
    chunks.push(chunk);
  }
  const total = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    total.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(total);
}

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

function printTable(results: BenchResult[], baseline: Baseline | null, threshold = 0.2): void {
  const hasBaseline = baseline !== null;
  const header = "  " + bold("Name".padEnd(52)) + bold("avg".padStart(12)) +
    (hasBaseline ? bold("Baseline".padStart(12)) + bold("Change".padStart(10)) : "");
  console.log("\n" + header);
  console.log(gray("  " + "─".repeat(hasBaseline ? 86 : 64)));

  for (const { name, avg } of results) {
    const saved = baseline?.results[name];
    if (!hasBaseline || saved === undefined) {
      console.log(`     ${name.padEnd(52)}${fmtNs(avg).padStart(12)}`);
      continue;
    }
    const change = (avg - saved) / saved;
    const flag = change > threshold ? bold(red(" FAIL")) : "     ";
    console.log(
      `${flag} ${name.padEnd(52)}${fmtNs(avg).padStart(12)}${dim(fmtNs(saved).padStart(12))}${fmtChange(change, threshold).padStart(10)}`,
    );
  }
  console.log();
}

async function save(results: BenchResult[]): Promise<void> {
  let existing: Baseline | null = null;
  try {
    existing = JSON.parse(await Deno.readTextFile(BASELINE_FILE));
  } catch { /* no prior baseline */ }

  printTable(results, existing);

  const baseline: Baseline = {
    savedAt: new Date().toISOString(),
    results: Object.fromEntries(results.map((r) => [r.name, r.avg])),
  };
  await Deno.writeTextFile(BASELINE_FILE, JSON.stringify(baseline, null, 2) + "\n");
  console.log(green(`Baseline saved: ${results.length} benchmark(s) → benches/results.json`));
}

async function check(results: BenchResult[], thresholdPct: number): Promise<boolean> {
  const threshold = thresholdPct / 100;
  let baseline: Baseline | null = null;
  try {
    baseline = JSON.parse(await Deno.readTextFile(BASELINE_FILE));
  } catch {
    console.log(yellow("No baseline found in benches/results.json."));
    console.log(dim("Run 'make bench' once to establish one, then re-run."));
    printTable(results, null, threshold);
    return true; // don't fail on first-ever run
  }

  console.log(`\nBenchmark regression check (threshold: ${yellow(`${thresholdPct}%`)})`);
  printTable(results, baseline, threshold);

  const failures = results.filter(({ name, avg }) => {
    const saved = baseline!.results[name];
    return saved !== undefined && (avg - saved) / saved > threshold;
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

const raw = await readStdin();
const results = parseResults(raw);

if (Deno.args.includes("--save")) {
  await save(results);
} else {
  const threshold = parseFloat(Deno.env.get("REGRESSION_THRESHOLD") ?? "20");
  const ok = await check(results, threshold);
  if (!ok) Deno.exit(1);
}
