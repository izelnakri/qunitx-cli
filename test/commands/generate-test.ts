import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as Generate from '../../lib/commands/generate.ts';
import { rmRetry } from '../helpers/rm-retry.ts';
import { execute as shell } from '../helpers/shell.ts';
import '../helpers/custom-asserts.ts';

const CWD = process.cwd();

/**
 * Runs `generate` the way the CLI does and returns the line the CLI would print, so these tests
 * keep asserting on the user-visible message while `Generate.run` itself only reports facts.
 */
async function generate(target: string): Promise<string> {
  const { path, created } = await Generate.run({ target });

  return created ? `${path} written\n` : `${path} already exists!\n`;
}

const readGenerated = (relativePath: string): Promise<string> =>
  fs.readFile(`${CWD}/${relativePath}`, 'utf-8');

module('Commands | generate | target path', { concurrency: false }, () => {
  test('appends .js when the target has no extension', async (assert) => {
    const target = `tmp/generated-${randomUUID()}`;

    await using stack = new AsyncDisposableStack();
    stack.defer(() => fs.rm(`${CWD}/${target}.js`, { force: true }));

    const printed = await generate(target);

    assert.includes(printed, `${CWD}/${target}.js written`, 'confirms the resolved .js path');
    assert.includes(await readGenerated(`${target}.js`), "module('", 'wrote the boilerplate');
  });

  test('preserves an explicit .js extension', async (assert) => {
    const target = `tmp/generated-${randomUUID()}.js`;

    await using stack = new AsyncDisposableStack();
    stack.defer(() => fs.rm(`${CWD}/${target}`, { force: true }));

    const printed = await generate(target);

    assert.includes(printed, `${CWD}/${target} written`);
    assert.includes(await readGenerated(target), "module('");
  });

  test('preserves an explicit .ts extension (no double extension)', async (assert) => {
    const target = `tmp/generated-${randomUUID()}.ts`;

    await using stack = new AsyncDisposableStack();
    stack.defer(() => fs.rm(`${CWD}/${target}`, { force: true }));

    const printed = await generate(target);

    assert.includes(printed, `${CWD}/${target} written`);
    assert.notIncludes(printed, '.ts.js');
    assert.includes(await readGenerated(target), "module('");
  });

  test('creates the intermediate directories of a nested target', async (assert) => {
    const root = `tmp/generated-dir-${randomUUID()}`;
    const target = `${root}/subdir/my-test.js`;

    await using stack = new AsyncDisposableStack();
    stack.defer(() => rmRetry(`${CWD}/${root}`));

    await generate(target);

    assert.includes(await readGenerated(target), "module('", 'file exists inside the new dirs');
  });

  test('prints "already exists" and leaves the existing file untouched', async (assert) => {
    const target = `tmp/generated-${randomUUID()}.js`;
    const originalContent = '// original content — must not be overwritten\n';

    await fs.mkdir(`${CWD}/tmp`, { recursive: true });
    await fs.writeFile(`${CWD}/${target}`, originalContent);
    await using stack = new AsyncDisposableStack();
    stack.defer(() => fs.rm(`${CWD}/${target}`, { force: true }));

    const printed = await generate(target);

    assert.includes(printed, 'already exists');
    assert.equal(await readGenerated(target), originalContent, 'content is unchanged');
  });
});

// Module-name derivation: convertToPascalCase itself is covered in
// test/utils/convert-to-pascal-case-test.ts; what is asserted here is generate's own layer —
// dropping a leading test/ segment and joining the rest with " | ".
module('Commands | generate | module name', { concurrency: false }, () => {
  test('joins the PascalCased path segments with " | "', async (assert) => {
    const root = `tmp/generate-${randomUUID()}`;
    const target = `${root}/controllers/user-contact-details.ts`;

    await using stack = new AsyncDisposableStack();
    stack.defer(() => rmRetry(`${CWD}/${root}`));

    await generate(target);

    assert.includes(await readGenerated(target), "| Controllers | UserContactDetails'");
  });

  test('drops a leading test/ segment so the module name starts at the folder below it', async (assert) => {
    const target = `test/generated-${randomUUID()}.ts`;

    await using stack = new AsyncDisposableStack();
    stack.defer(() => fs.rm(`${CWD}/${target}`, { force: true }));

    await generate(target);

    const content = await readGenerated(target);
    assert.includes(content, "module('Generated", 'name starts at the segment after test/');
    assert.notIncludes(content, "module('Test", 'the test/ segment is not part of the name');
  });
});

// One end-to-end spawn proving cli.ts dispatches `generate` into the command above and that
// the file lands on disk from a real process — everything else is asserted in-process.
module('Commands | generate | cli', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('$ qunitx generate <name> -> writes the test file and confirms the path', async (assert, testMetadata) => {
    const target = `tmp/generated-${randomUUID()}.ts`;

    await using stack = new AsyncDisposableStack();
    stack.defer(() => fs.rm(`${CWD}/${target}`, { force: true }));

    const { stdout } = await shell(`node cli.ts generate ${target}`, {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.includes(stdout, `${CWD}/${target} written`);
    assert.includes(await readGenerated(target), "module('");
  });
});
