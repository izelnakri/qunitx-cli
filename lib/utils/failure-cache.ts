import fs from 'node:fs/promises';
import path from 'node:path';
import * as SourceMap from './source-map.ts';
import type { SourceMapDecoder } from './source-map.ts';
import { pathExists } from './path-exists.ts';
import type { Config, FSTree } from '../types.ts';

// Persistent cross-run cache of the last run's failures, living beside tmp/test-timings.json.
// Always literal `tmp/` (not config.output) so `--only-failed` finds it regardless of the
// --output directory, mirroring the timing cache. tmp/ is gitignored and auto-created by
// buildTestBundle's mkdir.
const CACHE_FILENAME = 'tmp/.qunitx-last-failures.json';

/** One failed test, kept for display and future `-t` (test-name filter) wiring. */
export interface FailedTestRecord {
  /** Source file the failure was attributed to (relative to projectRoot), or `null` when unattributable. */
  file: string | null;
  /** QUnit module path, ` > `-joined; `''` for a top-level test. */
  module: string;
  /** The test's own name. */
  testName: string;
}

/** On-disk shape of `tmp/.qunitx-last-failures.json`. */
export interface FailureCache {
  /** Browser engine the failures were observed in. */
  browser: string;
  /** Absolute paths of test files that contained at least one failure — drives `--only-failed`. */
  files: string[];
  /** Per-test metadata for the failures above. */
  tests: FailedTestRecord[];
}

/** Reads the failure cache; returns `null` on a missing file or any parse/shape error. */
export async function readFailureCache(projectRoot: string): Promise<FailureCache | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(projectRoot, CACHE_FILENAME), 'utf8'));
    if (parsed && Array.isArray(parsed.files)) return parsed as FailureCache;
    return null;
  } catch {
    return null;
  }
}

/** Writes the failure cache. Best-effort; callers fire-and-forget like `persistTimings`. */
export async function writeFailureCache(projectRoot: string, cache: FailureCache): Promise<void> {
  await fs.writeFile(path.join(projectRoot, CACHE_FILENAME), JSON.stringify(cache, null, 2));
}

/**
 * Resolves the concrete previously-failing test files to re-run for `--only-failed`. Returns
 * `null` when no cache exists (the caller picks the fallback — run all, or a full watch start).
 * Otherwise returns the cached files that still exist, intersected with `fsTree` when input
 * targets were given (so failures stay scoped to what the user asked for) or the full cached set
 * when no targets were provided. Shared by the non-watch fsTree filter and the watch initial run.
 */
export async function resolveOnlyFailedFiles(
  projectRoot: string,
  hasInputTargets: boolean,
  fsTree: FSTree,
): Promise<string[] | null> {
  const cache = await readFailureCache(projectRoot);
  if (!cache) return null;
  const scoped = hasInputTargets ? cache.files.filter((file) => file in fsTree) : cache.files;
  const existing: string[] = [];
  for (const file of scoped) {
    if (await pathExists(file)) existing.push(file);
  }
  return existing;
}

/** Assembles the cache payload from the shared per-run failure slots on `config`. */
export function buildFailureCache(config: Config): FailureCache {
  return {
    browser: config.browser,
    files: Array.from(config.state.results.failedFiles ?? []),
    tests: config.state.results.failedTests ?? [],
  };
}

/**
 * Records a failed `testEnd` into the shared per-run slots (`state.results.failedFiles` / `failedTests`)
 * used to build the persistent cache. The failing file is attributed via source-map resolution
 * of the first failing assertion's stack; when that can't be resolved to one of the run's test
 * files (timeouts, no stack, a frame in a shared helper), the whole run/group set is added so a
 * failure is never dropped from `--only-failed`.
 *
 * No-op when the state slots are absent (unit-test configs built without run state).
 */
export function recordFailedTest(config: Config, details: FailedTestDetails): void {
  const results = config.state?.results;
  if (!results) return;
  const file = attributeFailureFile(
    details.assertions,
    config.state.group.sourceMapDecoder,
    config.projectRoot,
  );
  if (file && config.state.group.lastRanFiles?.includes(file)) {
    results.failedFiles.add(file);
  } else {
    config.state.group.lastRanFiles?.forEach((ranFile) => results.failedFiles.add(ranFile));
  }
  results.failedTests.push({
    file: file ? relativize(file, config.projectRoot) : null,
    module: details.fullName.slice(0, -1).join(' > '),
    testName: details.fullName.at(-1) ?? '',
  });
}

export { recordFailedTest as default };

interface FailedTestDetails {
  fullName: string[];
  assertions?: { passed: boolean; todo: boolean; stack?: string }[];
}

/**
 * Attributes a failed test to its source file by source-map-decoding the first failing
 * assertion's stack to its first user frame. Returns an absolute path, or `null` when no user
 * frame resolves. Mirrors the resolution `TAPDisplayTestResult` uses for the TAP `at:` field.
 */
function attributeFailureFile(
  assertions: FailedTestDetails['assertions'],
  decoder: SourceMapDecoder | null | undefined,
  projectRoot: string,
): string | null {
  if (!decoder || !assertions) return null;
  for (const assertion of assertions) {
    if (assertion.passed || assertion.todo || !assertion.stack) continue;
    const { firstUserFrame } = SourceMap.resolveStack(assertion.stack, decoder, projectRoot);
    if (!firstUserFrame) continue;
    // firstUserFrame is "path:line:col" (path relative to projectRoot, or absolute when outside
    // it); strip the location and re-root to an absolute path so it matches fsTree keys.
    return path.resolve(projectRoot, firstUserFrame.replace(/:\d+:\d+$/, ''));
  }
  return null;
}

function relativize(absolutePath: string, projectRoot: string): string {
  const prefix = `${projectRoot}/`;
  return absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : absolutePath;
}
