/**
 * End-to-end CLI benchmarks — measures real wall-clock time a user experiences.
 *
 * These spawn actual Node.js subprocesses (and Chrome for browser runs), so
 * iteration counts are kept low. Each bench covers a distinct cost layer:
 *
 *   startup  →  Node boot + module load (no Chrome)
 *   e2e-1    →  full run: bundle + browser launch + 1 test file + exit
 *   e2e-3    →  full run: bundle + browser launch + 3 concurrent test files + exit
 */
import { mkdir } from "node:fs/promises";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname;

// Ensure tmp/ exists for output directories.
await mkdir(`${PROJECT_ROOT}/tmp`, { recursive: true });

function spawnCLI(args: string[]): Promise<{ code: number }> {
  const id = crypto.randomUUID();
  const cmd = new Deno.Command("node", {
    args: ["cli.ts", ...args, `--output=tmp/bench-run-${id}`],
    cwd: PROJECT_ROOT,
    env: { ...Deno.env.toObject(), FORCE_COLOR: "0" },
    stdout: "null",
    stderr: "null",
  });
  return cmd.output();
}

// ─── startup ─────────────────────────────────────────────────────────────────
// Measures Node.js startup time + all module loads. No Chrome involved.
// This is the overhead every `qunitx` invocation pays before doing any work.
Deno.bench("cli: startup time (help)", {
  group: "cli",
  baseline: true,
  n: 5,
  warmup: 0,

}, async () => {
  const cmd = new Deno.Command("node", {
    args: ["cli.ts", "help"],
    cwd: PROJECT_ROOT,
    env: { ...Deno.env.toObject(), FORCE_COLOR: "0" },
    stdout: "null",
    stderr: "null",
  });
  await cmd.output();
});

// ─── e2e: single test file ────────────────────────────────────────────────────
// Measures the full critical path: config load → esbuild → browser launch →
// page navigation → QUnit run → WebSocket TAP stream → process exit.
// This is the baseline experience for the smallest possible project.
Deno.bench("cli: e2e run (1 passing test file)", {
  group: "cli",
  n: 3,
  warmup: 0,

}, async () => {
  await spawnCLI(["test/helpers/passing-tests.ts"]);
});

// ─── e2e: multiple test files (concurrent groups) ─────────────────────────────
// Exercises the concurrent group code-path in run.js: files are split across
// groups, each in its own browser tab. Measures parallelism overhead and the
// extra coordination cost of Promise.allSettled + shared COUNTER.
Deno.bench("cli: e2e run (3 passing test files, concurrent)", {
  group: "cli",
  n: 3,
  warmup: 0,

}, async () => {
  await spawnCLI([
    "test/helpers/passing-tests.ts",
    "test/helpers/passing-tests.ts",
    "test/helpers/passing-tests.ts",
  ]);
});
