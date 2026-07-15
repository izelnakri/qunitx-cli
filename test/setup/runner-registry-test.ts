import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { joinRunnerRegistry, liveRunners } from '../helpers/runner-registry.ts';

// Every test gets a private registry dir. The real one has this very runner registered in it,
// so using the default would have the suite observe itself.
const registryDir = () => path.join(process.cwd(), 'tmp', `runner-registry-${crypto.randomUUID()}`);
const exists = (target: string) =>
  fs
    .stat(target)
    .then(() => true)
    .catch(() => false);

// A pid that is definitely dead: spawn something trivial and wait for it to exit. Beats picking
// an arbitrary high number, which could belong to a real process on a busy machine.
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid!;
}

async function writeEntry(dir: string, pid: number): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, String(pid)), JSON.stringify({ pid, startedAt: Date.now() }));
}

const never = () => Promise.reject(new Error('onSolo must not run when another runner is live'));

module('Setup | runner registry', { concurrency: true }, () => {
  test('a solo runner wipes tmp/ and registers itself', async (assert) => {
    const dir = registryDir();
    let wiped = 0;
    const runner = await joinRunnerRegistry(() => void wiped++, dir);

    assert.true(runner.wasSolo, 'no other runner was live');
    assert.strictEqual(wiped, 1, 'the solo runner performs the wipe');
    assert.strictEqual(runner.runId, String(process.pid), 'runId identifies this runner');
    assert.true(await exists(path.join(dir, String(process.pid))), 'entry registered');

    await runner.release();
    assert.false(await exists(path.join(dir, String(process.pid))), 'release removes the entry');
  });

  test('does NOT wipe while another runner is live — the whole point', async (assert) => {
    const dir = registryDir();
    // A live runner other than us. Its own pid is alive by construction.
    await writeEntry(dir, process.ppid);

    const runner = await joinRunnerRegistry(never, dir);
    assert.false(runner.wasSolo, 'company detected');
    // never() would have rejected; reaching here proves the wipe was skipped.
    await runner.release();
  });

  test('a dead runner is reaped and does not suppress the wipe forever', async (assert) => {
    const dir = registryDir();
    await writeEntry(dir, await deadPid());

    let wiped = 0;
    const runner = await joinRunnerRegistry(() => void wiped++, dir);
    assert.true(runner.wasSolo, 'a crashed runner must not count as company');
    assert.strictEqual(wiped, 1, 'the wipe still happens');
    await runner.release();
  });

  test('a torn entry is ignored rather than wedging the registry', async (assert) => {
    const dir = registryDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '999999'), 'not json');

    const runner = await joinRunnerRegistry(() => {}, dir);
    assert.true(runner.wasSolo, 'unparseable entries do not count as live runners');
    await runner.release();
  });

  test('the mutex is released, so a later runner is never blocked', async (assert) => {
    const dir = registryDir();
    const first = await joinRunnerRegistry(() => {}, dir);
    await first.release();

    // Would hang if the first join had kept the mutex.
    const second = await joinRunnerRegistry(() => {}, dir);
    assert.true(second.wasSolo, 'the released entry left no trace');
    await second.release();
  });

  test('liveRunners reports others and reaps the dead', async (assert) => {
    const dir = registryDir();
    await writeEntry(dir, process.ppid);
    const gone = await deadPid();
    await writeEntry(dir, gone);

    const live = await liveRunners(dir);
    assert.strictEqual(live.length, 1, 'only the live entry is reported');
    assert.strictEqual(live[0].pid, process.ppid);
    assert.false(await exists(path.join(dir, String(gone))), 'the dead entry is reaped');
  });

  test('liveRunners excludes ourselves', async (assert) => {
    const dir = registryDir();
    await writeEntry(dir, process.pid);
    assert.deepEqual(await liveRunners(dir), [], 'our own entry is not company');
  });
});
