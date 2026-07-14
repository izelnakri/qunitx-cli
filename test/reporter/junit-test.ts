import { module, test } from 'qunitx';
import { buildJUnitXML } from '../../lib/reporter/junit.ts';
import type { JUnitCase } from '../../lib/types.ts';

module('reporters | buildJUnitXML', { concurrency: true }, () => {
  const cases: JUnitCase[] = [
    { classname: 'Math', name: 'adds', time: 0.003, status: 'passed' },
    { classname: 'Math', name: 'divides', time: 0.5, status: 'passed' },
    {
      classname: 'Strings',
      name: 'reverses',
      time: 0.01,
      status: 'failed',
      failureMessage: 'expected "cba"',
      failureDetail: 'expected "cba" but got "abc"\nat src/strings.ts:4:2',
    },
    { classname: 'Strings', name: 'todo item', time: 0, status: 'todo' },
    { classname: 'Strings', name: 'skipped item', time: 0, status: 'skipped' },
  ];

  test('emits an XML declaration and a testsuites root with rolled-up totals', (assert) => {
    const xml = buildJUnitXML(cases);
    assert.true(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'has XML declaration');
    assert.true(
      /<testsuites name="qunitx" tests="5" failures="1" skipped="2" time="0\.513">/.test(xml),
      'testsuites totals (todo counts as skipped)',
    );
  });

  test('groups test cases into one testsuite per classname', (assert) => {
    const xml = buildJUnitXML(cases);
    assert.true(
      /<testsuite name="Math" tests="2" failures="0" skipped="0"/.test(xml),
      'Math suite',
    );
    assert.true(
      /<testsuite name="Strings" tests="3" failures="1" skipped="2"/.test(xml),
      'Strings suite',
    );
  });

  test('passing cases are self-closing; failed cases carry a <failure>', (assert) => {
    const xml = buildJUnitXML(cases);
    assert.true(
      xml.includes('<testcase name="adds" classname="Math" time="0.003"/>'),
      'passing testcase is self-closing',
    );
    assert.true(
      xml.includes('<failure message="expected &quot;cba&quot;">'),
      'failure message is attribute-escaped',
    );
    assert.true(xml.includes('at src/strings.ts:4:2'), 'failure detail included');
  });

  test('todo and skipped cases render a <skipped/> element', (assert) => {
    const xml = buildJUnitXML(cases);
    assert.equal((xml.match(/<skipped\/>/g) ?? []).length, 2, 'two skipped elements');
  });

  test('escapes XML metacharacters in names', (assert) => {
    const xml = buildJUnitXML([
      { classname: 'A & B', name: '<tag> "q"', time: 0, status: 'passed' },
    ]);
    assert.true(xml.includes('classname="A &amp; B"'), 'ampersand escaped in attribute');
    assert.true(
      xml.includes('name="&lt;tag&gt; &quot;q&quot;"'),
      'angle brackets + quotes escaped',
    );
  });

  test('root classname fallback for single-element fullNames', (assert) => {
    const xml = buildJUnitXML([
      { classname: '(root)', name: 'top level', time: 0, status: 'passed' },
    ]);
    assert.true(xml.includes('<testsuite name="(root)"'), 'root suite name used');
  });
});
