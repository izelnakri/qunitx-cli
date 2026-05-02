// Custom node:test reporter — emits one JSON line per test/suite completion
// with { name, file, ms, kind, nesting }. Consumed by test/runner.ts to
// populate the GitHub Actions step summary's slowest-{file,group,test} rows.
// The default TAP reporter still streams to stdout — this only adds parseable
// timing data alongside it.
import path from 'node:path';
import process from 'node:process';

type TestEvent = {
  type: string;
  data: {
    name: string;
    file?: string;
    nesting: number;
    details?: { duration_ms?: number; type?: string };
  };
};

export default async function* ciTestSummaryReporter(source: AsyncIterable<TestEvent>) {
  for await (const { type, data } of source) {
    if (type !== 'test:pass' && type !== 'test:fail') continue;
    yield JSON.stringify({
      name: data.name,
      file: data.file ? path.relative(process.cwd(), data.file) : '',
      ms: data.details?.duration_ms ?? 0,
      kind: data.details?.type ?? 'test',
      nesting: data.nesting,
    }) + '\n';
  }
}
