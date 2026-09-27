import path from 'node:path';
import process from 'node:process';
import { module, test } from 'qunitx';
import { spawn } from '../../lib/repl/inspector/spawn.ts';
import { connect } from '../../lib/repl/inspector/client.ts';
import type { InspectorClient } from '../../lib/repl/inspector/client.ts';
import { installedRuntimes } from '../helpers/installed-runtimes.ts';
import type { RuntimeName } from '../../lib/setup/targets.ts';
import '../helpers/custom-asserts.ts';

// Against REAL runtimes, deliberately. A stubbed inspector would have agreed with every wrong
// assumption this layer started life with — that `import()` works inside `Runtime.evaluate` (it
// does not, on either runtime), and that `--inspect-brk` releases on `runIfWaitingForDebugger`
// (it does not; it then stops again on the first statement). Both cost an afternoon, and both are
// invisible to anything but a process.

const ROOT = path.resolve(import.meta.dirname!, '..', '..');
/** Everything a prompt does at start-up, in the order that is load-bearing. */
async function attach(runtime: RuntimeName): Promise<{
  client: InspectorClient;
  evaluate: (expression: string) => Promise<unknown>;
  [Symbol.asyncDispose](): Promise<void>;
}> {
  const started = await spawn(runtime, ROOT);
  const client = await connect(started.inspectorURL);
  // ONLY the break-on-start. A handler that resumed every pause would resume the breakpoint a
  // test had just set, out from under the test that set it.
  let released = false;
  client.on('Debugger.paused', () => {
    if (released) return;
    released = true;
    void client.send('Debugger.resume');
  });
  await client.send('Runtime.enable');
  await client.send('Debugger.enable');
  await client.send('Runtime.runIfWaitingForDebugger');
  // The break-on-start arrives as an event; the resume above answers it. Without this wait the
  // event loop has not turned yet and the first `awaitPromise` hangs forever.
  await new Promise((done) => setTimeout(done, 700));

  return {
    client,
    async evaluate(expression: string): Promise<unknown> {
      const answer = await client.send<{
        result: { value?: unknown };
        exceptionDetails?: { text: string };
      }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });

      if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.text);

      return answer.result.value;
    },
    async [Symbol.asyncDispose]() {
      client.close();
      await started.shutdown();
    },
  };
}

for (const runtime of installedRuntimes()) {
  module(`Repl | inspector | ${runtime}`, () => {
    test('it starts stopped, and runs once it is told to', async (assert) => {
      await using target = await attach(runtime);

      assert.strictEqual(await target.evaluate('1 + 1'), 2);
      assert.strictEqual(await target.evaluate('typeof globalThis.__qunitxImport'), 'function');
    });

    // The one that decides whether any of this is a prompt. `import()` written straight into
    // `Runtime.evaluate` fails on BOTH runtimes — no module resolution callback in that context —
    // so everything a person types that loads anything goes through the host's bridge.
    test('the host bridge imports what Runtime.evaluate cannot', async (assert) => {
      await using target = await attach(runtime);

      // node says ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING and deno says "not a dependency"; the
      // wording is theirs and not worth pinning, but both refuse. A bare PACKAGE specifier is the
      // case they agree on — deno resolves `node:` builtins in that context and node does not.
      await assert.rejects(target.evaluate(`import('qunitx').then((m) => typeof m.test)`));
      assert.strictEqual(
        await target.evaluate(`__qunitxImport('node:os').then((m) => m.platform())`),
        process.platform,
      );
    });

    test('a bare specifier resolves from the project, not from a temp directory', async (assert) => {
      await using target = await attach(runtime);

      const exported = await target.evaluate(
        `__qunitxImport('qunitx').then((m) => Object.keys(m).sort().join(','))`,
      );

      assert.includes(String(exported), 'module', `this project's own qunitx resolved`);
      assert.includes(String(exported), 'test');
    });

    test('TypeScript is imported as it is on disk, with no bundler anywhere', async (assert) => {
      await using target = await attach(runtime);
      const file = `file://${path.join(ROOT, 'lib', 'repl', 'http-service.ts')}`;

      assert.strictEqual(
        await target.evaluate(
          `__qunitxImport(${JSON.stringify(file)}).then((m) => typeof m.create)`,
        ),
        'function',
      );
    });

    // The bridge lives in `node_modules/.cache/qunitx`, so a RELATIVE specifier resolves from
    // there and not from the project — which is why whatever loads a file for a person has to
    // make the path absolute first. Stated here because it is the kind of thing that otherwise
    // gets rediscovered as "why does .import take the wrong file".
    test('a relative specifier resolves from the host, which is why callers pass absolute ones', async (assert) => {
      await using target = await attach(runtime);

      await assert.rejects(target.evaluate(`__qunitxImport('./lib/repl/http-service.ts')`));
    });

    test('a module with no file, for code built at the prompt', async (assert) => {
      await using target = await attach(runtime);

      assert.strictEqual(
        await target.evaluate(`__qunitxImportSource('export const v = 7').then((m) => m.v)`),
        7,
      );
    });

    // `replMode` is what makes a prompt a prompt: two lines, one scope.
    test('a top-level let survives into the next evaluation', async (assert) => {
      await using target = await attach(runtime);

      await target.client.send('Runtime.evaluate', {
        expression: 'let remembered = 20',
        replMode: true,
      });
      const doubled = await target.client.send<{ result: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression: 'remembered * 2', replMode: true, returnByValue: true },
      );
      const lexical = await target.client.send<{ names?: string[] }>(
        'Runtime.globalLexicalScopeNames',
        {},
      );

      assert.strictEqual(doubled.result.value, 40);
      assert.deepEqual(lexical.names, ['remembered'], '.scope can see what was declared');
    });

    test('a breakpoint in a file the prompt imports stops it, with its locals readable', async (assert) => {
      await using target = await attach(runtime);
      const file = path.join(ROOT, 'test', 'fixtures', 'repl-breakable.mjs');

      // Set BEFORE the file is loaded, which is the whole reason the runtime starts stopped.
      // Whether V8 binds it now or when the script parses is V8's business and varies with what
      // the runtime already has cached — what matters is that it is accepted, and that it stops
      // the import below.
      const set = await target.client.send<{ breakpointId?: string }>(
        'Debugger.setBreakpointByUrl',
        {
          lineNumber: 1,
          columnNumber: 0,
          url: `file://${file}`,
        },
      );
      assert.ok(set.breakpointId, 'the breakpoint is accepted before anything has loaded');

      const stopped = new Promise<{
        callFrames: Array<{ scopeChain: Array<{ type: string; object: { objectId?: string } }> }>;
      }>((resolve) => target.client.on('Debugger.paused', resolve as (params: never) => void));
      void target.client.send('Runtime.evaluate', {
        expression: `__qunitxImport(${JSON.stringify(`file://${file}`)}).then((m) => m.hit())`,
        awaitPromise: true,
      });

      const pause = await Promise.race([
        stopped,
        // Generous: this runs alongside fifteen other workers and a browser semaphore, and a
        // cold `deno run` under that is not a fast thing.
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
      ]);
      assert.ok(pause, 'the pending breakpoint resolved when the file finally loaded');

      const local = pause!.callFrames[0]!.scopeChain.find((scope) => scope.type === 'local');
      const properties = await target.client.send<{ result: Array<{ name: string }> }>(
        'Runtime.getProperties',
        { objectId: local!.object.objectId, ownProperties: true },
      );

      assert.true(
        properties.result.some((property) => property.name === 'answer'),
        'a stopped scope is readable without running anything in it',
      );
      await target.client.send('Debugger.resume');
    });

    test('an evaluation that outlives its runtime is answered, not left hanging', async (assert) => {
      const started = await spawn(runtime, ROOT);
      const client = await connect(started.inspectorURL);
      await client.send('Runtime.enable');

      // A prompt whose runtime dies mid-question must get an answer to the question. Before the
      // socket's close handler settled what was outstanding, this hung until the process ended.
      const asked = client.send('Runtime.evaluate', {
        expression: 'new Promise(() => {})',
        awaitPromise: true,
      });
      // The assertion attaches its handler BEFORE the runtime dies: a rejection nobody is holding
      // yet is an unhandled rejection, which node:test fails the whole file for.
      const settled = assert.rejects(asked);
      await started.shutdown();

      await settled;
      client.close();
    });
  });
}
