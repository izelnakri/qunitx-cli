import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as Generate from '../../lib/commands/generate.ts';
import { rmRetry } from '../helpers/rm-retry.ts';
import { execute as shell } from '../helpers/shell.ts';
import '../helpers/custom-asserts.ts';

const CWD = process.cwd();

/**
 * Runs the generate command in-process against `target`, exactly as `qunitx generate <target>`
 * would: the command reads its argument off process.argv[3] and resolves paths from
 * findProjectRoot(), which walks up from the test worker's cwd to this repository's root.
 * Returns whatever the command printed.
 *
 * argv and console are process-wide, hence the `concurrency: false` on the modules below —
 * Generate.run() awaits, so a concurrent sibling could otherwise observe the stubs.
 *
 * console.log is swapped rather than process.stdout.write (what helpers/capture-stdout.ts
 * does): the node:test reporter writes this worker's results straight to the stdout stream,
 * and holding that stream across an await swallows the result lines of whatever else the
 * worker reports meanwhile — tests then silently disappear from the run summary.
 */
async function generate(target: string): Promise<string> {
  const originalArgv = process.argv;
  const originalLog = console.log;
  let printed = '';

  process.argv = ['node', 'cli.ts', 'generate', target];
  console.log = (...args: unknown[]) => {
    printed += `${args.join(' ')}\n`;
  };
  try {
    await Generate.run();
  } finally {
    console.log = originalLog;
    process.argv = originalArgv;
  }
  return printed;
}

const readGenerated = (relativePath: string): Promise<string> =>
  fs.readFile(`${CWD}/${relativePath}`, 'utf-8');

module('Commands | generate | target path', { concurrency: false }, () => {
  test('appends .js when the target has no extension', async (assert) => {
    const target = `tmp/generated-${randomUUID()}`;

    try {
      const printed = await generate(target);

      assert.includes(printed, `${CWD}/${target}.js written`, 'confirms the resolved .js path');
      assert.includes(await readGenerated(`${target}.js`), "module('", 'wrote the boilerplate');
    } finally {
      await fs.rm(`${CWD}/${target}.js`, { force: true });
    }
  });

  test('preserves an explicit .js extension', async (assert) => {
    const target = `tmp/generated-${randomUUID()}.js`;

    try {
      const printed = await generate(target);

      assert.includes(printed, `${CWD}/${target} written`);
      assert.includes(await readGenerated(target), "module('");
    } finally {
      await fs.rm(`${CWD}/${target}`, { force: true });
    }
  });

  test('preserves an explicit .ts extension (no double extension)', async (assert) => {
    const target = `tmp/generated-${randomUUID()}.ts`;

    try {
      const printed = await generate(target);

      assert.includes(printed, `${CWD}/${target} written`);
      assert.notIncludes(printed, '.ts.js');
      assert.includes(await readGenerated(target), "module('");
    } finally {
      await fs.rm(`${CWD}/${target}`, { force: true });
    }
  });

  test('creates the intermediate directories of a nested target', async (assert) => {
    const root = `tmp/generated-dir-${randomUUID()}`;
    const target = `${root}/subdir/my-test.js`;

    try {
      await generate(target);

      assert.includes(await readGenerated(target), "module('", 'file exists inside the new dirs');
    } finally {
      await rmRetry(`${CWD}/${root}`);
    }
  });

  test('prints "already exists" and leaves the existing file untouched', async (assert) => {
    const target = `tmp/generated-${randomUUID()}.js`;
    const originalContent = '// original content — must not be overwritten\n';

    await fs.mkdir(`${CWD}/tmp`, { recursive: true });
    await fs.writeFile(`${CWD}/${target}`, originalContent);
    try {
      const printed = await generate(target);

      assert.includes(printed, 'already exists');
      assert.equal(await readGenerated(target), originalContent, 'content is unchanged');
    } finally {
      await fs.rm(`${CWD}/${target}`, { force: true });
    }
  });
});

// Module-name derivation: convertToPascalCase itself is covered in
// test/utils/convert-to-pascal-case-test.ts; what is asserted here is generate's own layer —
// dropping a leading test/ segment and joining the rest with " | ".
module('Commands | generate | module name', { concurrency: false }, () => {
  test('joins the PascalCased path segments with " | "', async (assert) => {
    const root = `tmp/generate-${randomUUID()}`;
    const target = `${root}/controllers/user-contact-details.ts`;

    try {
      await generate(target);

      assert.includes(await readGenerated(target), "| Controllers | UserContactDetails'");
    } finally {
      await rmRetry(`${CWD}/${root}`);
    }
  });

  test('drops a leading test/ segment so the module name starts at the folder below it', async (assert) => {
    const target = `test/generated-${randomUUID()}.ts`;

    try {
      await generate(target);

      const content = await readGenerated(target);
      assert.includes(content, "module('Generated", 'name starts at the segment after test/');
      assert.notIncludes(content, "module('Test", 'the test/ segment is not part of the name');
    } finally {
      await fs.rm(`${CWD}/${target}`, { force: true });
    }
  });
});

// One end-to-end spawn proving cli.ts dispatches `generate` into the command above and that
// the file lands on disk from a real process — everything else is asserted in-process.
module('Commands | generate | cli', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('$ qunitx generate <name> -> writes the test file and confirms the path', async (assert, testMetadata) => {
    const target = `tmp/generated-${randomUUID()}.ts`;

    try {
      const { stdout } = await shell(`node cli.ts generate ${target}`, {
        ...moduleMetadata,
        ...testMetadata,
      });

      assert.includes(stdout, `${CWD}/${target} written`);
      assert.includes(await readGenerated(target), "module('");
    } finally {
      await fs.rm(`${CWD}/${target}`, { force: true });
    }
  });
});
