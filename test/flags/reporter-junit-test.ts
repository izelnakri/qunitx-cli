import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import '../helpers/custom-asserts.ts';
import shell, { shellFails } from '../helpers/shell.ts';

module('--reporter=junit', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('writes junit.xml alongside the streamed TAP for a passing run', async (assert, testMetadata) => {
    const output = `tmp/junit-pass-${randomUUID()}`;
    try {
      const result = await shell(
        `node cli.ts test/fixtures/passing-tests.ts --reporter=junit --output=${output}`,
        { ...moduleMetadata, ...testMetadata },
      );

      // TAP is unchanged — it still streams to stdout.
      assert.tapResult(result, { testCount: 3 });
      assert.includes(result, 'wrote JUnit report');

      const xml = await fs.readFile(`${output}/junit.xml`, 'utf8');
      assert.ok(
        xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'),
        'XML declaration present',
      );
      assert.ok(
        /<testsuites name="qunitx" tests="3" failures="0" skipped="0"/.test(xml),
        'testsuites totals',
      );
      assert.equal((xml.match(/<testcase /g) ?? []).length, 3, 'three testcases');
    } finally {
      await fs.rm(output, { recursive: true, force: true });
    }
  });

  test('records failures as <failure> elements and still exits non-zero', async (assert, testMetadata) => {
    const output = `tmp/junit-fail-${randomUUID()}`;
    try {
      const result = await shellFails(
        `node cli.ts test/fixtures/failing-tests.ts --reporter=junit --output=${output}`,
        { ...moduleMetadata, ...testMetadata },
      );
      assert.exitCode(result, 1, 'failing run exits 1');

      const xml = await fs.readFile(`${output}/junit.xml`, 'utf8');
      assert.ok(/<testsuites name="qunitx" tests="4" failures="3"/.test(xml), 'failure count');
      assert.ok(xml.includes('<failure'), 'failure element present');
      // Stack in the failure detail is resolved back to the original source file.
      assert.ok(xml.includes('test/fixtures/failing-tests.ts'), 'source-mapped stack in failure');
    } finally {
      await fs.rm(output, { recursive: true, force: true });
    }
  });

  test('--junit-output overrides the destination path (nested dirs created)', async (assert, testMetadata) => {
    const output = `tmp/junit-custom-${randomUUID()}`;
    const junitPath = `${output}/reports/nested/report.xml`;
    try {
      await shell(
        `node cli.ts test/fixtures/passing-tests.ts --reporter=junit --junit-output=${junitPath} --output=${output}`,
        { ...moduleMetadata, ...testMetadata },
      );
      const xml = await fs.readFile(junitPath, 'utf8');
      assert.ok(xml.includes('<testsuites'), 'JUnit written to the overridden path');
      const defaultExists = await fs
        .stat(`${output}/junit.xml`)
        .then(() => true)
        .catch(() => false);
      assert.notOk(defaultExists, 'default junit.xml is not written when overridden');
    } finally {
      await fs.rm(output, { recursive: true, force: true });
    }
  });

  test('tap remains the default reporter (no junit.xml without the flag)', async (assert, testMetadata) => {
    const output = `tmp/junit-none-${randomUUID()}`;
    try {
      const result = await shell(`node cli.ts test/fixtures/passing-tests.ts --output=${output}`, {
        ...moduleMetadata,
        ...testMetadata,
      });
      assert.notIncludes(result, 'wrote JUnit report');
      const junitExists = await fs
        .stat(`${output}/junit.xml`)
        .then(() => true)
        .catch(() => false);
      assert.notOk(junitExists, 'no junit.xml by default');
    } finally {
      await fs.rm(output, { recursive: true, force: true });
    }
  });
});
