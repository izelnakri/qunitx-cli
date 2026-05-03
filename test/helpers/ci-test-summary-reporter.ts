// Custom node:test reporter — emits one JSON line per test/suite completion with
// { name, file, ms, kind, nesting, status, error? }. Consumed by test/runner.ts both
// for the GitHub Actions step-summary slowest-{file,group,test} rows AND to render
// junit XML (with file paths + failure messages) for dorny/test-reporter — node:test's
// built-in junit reporter omits both. Combining the two consumers into one reporter
// keeps us at 2 reporters total (spec + this), which stays under node:test's
// MaxListeners=10 ceiling on TestsStream.
import path from 'node:path';
import process from 'node:process';
import { inspect } from 'node:util';

type TestEvent = {
  type: string;
  data: {
    name: string;
    file?: string;
    nesting: number;
    details?: { duration_ms?: number; type?: string; error?: unknown };
  };
};

export default async function* ciTestSummaryReporter(source: AsyncIterable<TestEvent>) {
  for await (const { type, data } of source) {
    if (type !== 'test:pass' && type !== 'test:fail') continue;
    const isFail = type === 'test:fail';
    yield JSON.stringify({
      name: data.name,
      file: data.file ? path.relative(process.cwd(), data.file) : '',
      ms: data.details?.duration_ms ?? 0,
      kind: data.details?.type ?? 'test',
      nesting: data.nesting,
      status: isFail ? 'fail' : 'pass',
      // For failures, capture the error object as one inspect()'d string with depth=4
      // so AssertionError → cause → cause chains render fully. Capped at 4KB so a
      // runaway stack/diff doesn't bloat the JSONL or the junit XML it feeds.
      ...(isFail && {
        error: inspect(data.details?.error, { depth: 4, breakLength: 120 }).slice(0, 4096),
      }),
    }) + '\n';
  }
}
