import { spawn } from 'node:child_process';
import { module, test } from 'qunitx';

// Result, Failure and Task are the universal abstractions of this codebase: they must load
// and work on any major JS environment — browsers included — so their runtime graph may not
// touch `process`, `node:` imports, or any other platform global bare. failure.ts reaches
// its one platform seam (diagnostics_channel) through `globalThis.process?.getBuiltinModule`
// precisely so that chain resolves to undefined where the platform is absent. This test is
// the regression guard: it re-imports the real modules in a child with `globalThis.process`
// deleted — the closest a Node lane can get to a browser realm — and exercises the surface.
module('Result | portability', { concurrency: true }, () => {
  test('the Result/Failure/Task graph loads and works without a process global', async (assert) => {
    if ('Deno' in globalThis) {
      return assert.true(true, 'skipped under Deno — the node lane owns this child-process assert');
    }
    const resultBarrel = new URL('../../lib/result/index.ts', import.meta.url).href;
    const taskBarrel = new URL('../../lib/task/index.ts', import.meta.url).href;
    const script =
      `delete globalThis.process;` +
      `const Result = await import(${JSON.stringify(resultBarrel)});` +
      `const { Task, Failure } = await import(${JSON.stringify(taskBarrel)});` +
      `const parsed = Result.try(JSON.parse, '{"n":1}');` +
      `const FileMissing = Failure.define('FileMissing', (d) => 'no ' + d.path);` +
      `const doubled = await Task(() => 21).map((n) => n * 2);` +
      `const failed = await Task(() => { throw FileMissing({ path: 'a.ts' }); }).result();` +
      `Failure.setDebug(true);` + // debug line must fall back to console.error, not crash
      `Task(() => Promise.reject(new Error('gone'))).ignore('browser cleanup');` +
      `await new Promise((res) => setTimeout(res, 10));` +
      `console.log('OK', parsed.value.n, doubled, Failure.is(failed), failed.code);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    assert.strictEqual(code, 0, `clean exit, got stderr: ${stderr}`);
    assert.true(stdout.includes('OK 1 42 true FileMissing'), 'the full surface worked');
    assert.true(
      stderr.includes('ignored (browser cleanup)'),
      'the debug line reached console.error without a process.stderr',
    );
  });
});
