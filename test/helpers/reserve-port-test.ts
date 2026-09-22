import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RESERVED_RANGE, reservePort } from './reserve-port.ts';
import { tempDir } from './temp-dir.ts';

const run = promisify(execFile);

module('Helpers | reservePort', { concurrency: true }, () => {
  test('a port from below every OS’s ephemeral range, so nothing else is handed it', async (assert) => {
    const port = await reservePort();

    assert.true(port >= RESERVED_RANGE.from && port <= RESERVED_RANGE.to, String(port));
    assert.true(port < 32768, 'below Linux’s ephemeral floor, the lowest of the three');
  });

  test('concurrent callers in one process never share a port', async (assert) => {
    await using dir = await tempDir('reserve-port-one');
    const ports = await Promise.all(
      Array.from({ length: 40 }, () => reservePort({ claims: dir.path })),
    );

    assert.strictEqual(new Set(ports).size, ports.length);
  });

  test('neither do callers in different processes — what test workers are', async (assert) => {
    // Three processes take 20 each from a range of 100: with per-process bookkeeping a collision
    // is all but certain, and with the shared atomic claims it cannot happen.
    await using dir = await tempDir('reserve-port-many');
    const script = path.join(dir.path, 'reserve.ts');
    // A file URL, not a path: `C:\…\reserve-port.ts` is read as a URL whose scheme is `c:`, which
    // both runtimes refuse — how this test failed on the Windows lanes.
    const helper = new URL('./reserve-port.ts', import.meta.url).href;
    await fs.writeFile(
      script,
      `import { reservePort } from ${JSON.stringify(helper)};\n` +
        `const claims = ${JSON.stringify(path.join(dir.path, 'claims'))};\n` +
        `const range = { from: 28000, to: 28099 };\n` +
        `const ports = await Promise.all(Array.from({ length: 20 }, () => reservePort({ range, claims })));\n` +
        `console.log(JSON.stringify(ports));\n`,
    );
    const argv = 'Deno' in globalThis ? ['run', '-A', script] : [script];
    const outputs = await Promise.all([1, 2, 3].map(() => run(process.execPath, argv)));
    const ports = outputs.flatMap(({ stdout }) => JSON.parse(stdout) as number[]);

    assert.strictEqual(ports.length, 60);
    assert.strictEqual(new Set(ports).size, 60, 'every one distinct across the three processes');
  });

  test('a port something on the machine already listens on is passed over', async (assert) => {
    await using dir = await tempDir('reserve-port-held');
    const range = { from: 29500, to: 29502 };
    const held = await Promise.all([listen(29500), listen(29501)]);
    try {
      assert.strictEqual(await reservePort({ range, claims: dir.path }), 29502);
    } finally {
      await Promise.all(held.map(close));
    }
  });
});

function listen(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
