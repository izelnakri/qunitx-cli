import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import shell from '../helpers/shell.js';

module('Commands | generate tests', (_hooks, moduleMetadata) => {
  test('appends .js extension and writes boilerplate when no extension is given', async (assert, testMetadata) => {
    const name = `tmp/generated-${randomUUID()}`;
    const expectedPath = `${process.cwd()}/${name}.js`;

    try {
      const { stdout } = await shell(`node cli.js generate ${name}`, {
        ...moduleMetadata,
        ...testMetadata,
      });

      assert.ok(stdout.includes('written'), 'prints a confirmation message');
      assert.ok(stdout.includes(expectedPath), 'confirmation includes the full resolved path');

      const content = await fs.readFile(expectedPath, 'utf-8');
      assert.ok(content.includes("module('"), 'generated file contains a module() call');
      assert.ok(
        content.includes(name),
        'the {{moduleName}} placeholder is replaced with the given path',
      );
    } finally {
      await fs.rm(expectedPath, { force: true });
    }
  });

  test('preserves .js extension when one is provided', async (assert, testMetadata) => {
    const targetPath = `tmp/generated-${randomUUID()}.js`;
    const expectedPath = `${process.cwd()}/${targetPath}`;

    try {
      const { stdout } = await shell(`node cli.js generate ${targetPath}`, {
        ...moduleMetadata,
        ...testMetadata,
      });

      assert.ok(stdout.includes('written'), 'prints a confirmation message');

      const content = await fs.readFile(expectedPath, 'utf-8');
      assert.ok(content.includes("module('"), 'generated file contains a module() call');
    } finally {
      await fs.rm(expectedPath, { force: true });
    }
  });

  test('preserves .ts extension when one is provided', async (assert, testMetadata) => {
    const targetPath = `tmp/generated-${randomUUID()}.ts`;
    const expectedPath = `${process.cwd()}/${targetPath}`;

    try {
      const { stdout } = await shell(`node cli.js generate ${targetPath}`, {
        ...moduleMetadata,
        ...testMetadata,
      });

      assert.ok(stdout.includes('written'), 'prints a confirmation message');

      const content = await fs.readFile(expectedPath, 'utf-8');
      assert.ok(content.includes("module('"), 'generated .ts file contains a module() call');
    } finally {
      await fs.rm(expectedPath, { force: true });
    }
  });

  test('creates intermediate directories when the target path includes new subdirectories', async (assert, testMetadata) => {
    const uuid = randomUUID();
    const targetPath = `tmp/generated-dir-${uuid}/subdir/my-test.js`;
    const expectedPath = `${process.cwd()}/${targetPath}`;

    try {
      const { stdout } = await shell(`node cli.js generate ${targetPath}`, {
        ...moduleMetadata,
        ...testMetadata,
      });

      assert.ok(stdout.includes('written'), 'prints a confirmation message');

      const content = await fs.readFile(expectedPath, 'utf-8');
      assert.ok(content.includes("module('"), 'file was created inside the nested directory');
    } finally {
      await fs.rm(`${process.cwd()}/tmp/generated-dir-${uuid}`, {
        recursive: true,
        force: true,
      });
    }
  });

  test('prints "already exists" and does not overwrite an existing file', async (assert, testMetadata) => {
    const targetPath = `tmp/generated-${randomUUID()}.js`;
    const expectedPath = `${process.cwd()}/${targetPath}`;
    const originalContent = '// original content — must not be overwritten\n';

    await fs.mkdir(`${process.cwd()}/tmp`, { recursive: true });
    await fs.writeFile(expectedPath, originalContent);

    try {
      const { stdout } = await shell(`node cli.js generate ${targetPath}`, {
        ...moduleMetadata,
        ...testMetadata,
      });

      assert.ok(stdout.includes('already exists'), 'prints "already exists" when file is present');

      const content = await fs.readFile(expectedPath, 'utf-8');
      assert.equal(content, originalContent, 'existing file content is not overwritten');
    } finally {
      await fs.rm(expectedPath, { force: true });
    }
  });
});
