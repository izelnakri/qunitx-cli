import { summarizeCoverage } from './coverage.ts';
import type { Config } from '../types.ts';
import type { RunResult, TestResult } from './types.ts';

/** Assembles the public {@link RunResult} from the run's counters and collected tests. */
export function buildResult(
  config: Config,
  tests: TestResult[],
  exitCode: number,
  duration: number,
): RunResult {
  const { COUNTER } = config;
  return {
    ok: exitCode === 0,
    exitCode,
    counts: {
      total: COUNTER.testCount,
      passed: COUNTER.passCount,
      failed: COUNTER.failCount,
      skipped: COUNTER.skipCount,
      todo: COUNTER.todoCount,
    },
    duration,
    tests,
    failures: tests.filter((test) => test.status === 'failed'),
    failedFiles: Array.from(config._failedTestFiles ?? []),
    ...(config.coverage ? { coverage: summarizeCoverage(config) } : {}),
  };
}
