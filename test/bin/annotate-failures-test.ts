import { module, test } from 'qunitx';
import { asAnnotation, failuresFrom } from '../../scripts/annotate-failures.ts';
import '../helpers/custom-asserts.ts';

// A red CI job used to be undiagnosable from outside the repository: logs need admin rights,
// artifacts need a token, the Actions UI is JavaScript, and dorny said only "Failed test were
// found". Annotations are readable by anyone, so the failing test names go there.

module('Bin | annotating failures | reading junit', { concurrency: true }, () => {
  test('a failing testcase is found, a passing one is not', (assert) => {
    const found = failuresFrom(`<testsuites><testsuite name="a-test.ts">
      <testcase name="adds" classname="a-test.ts" time="0.1"/>
      <testcase name="breaks" classname="a-test.ts"><failure message="nope"/></testcase>
    </testsuite></testsuites>`);

    assert.deepEqual(found, [{ file: 'a-test.ts', name: 'breaks', message: 'nope' }]);
  });

  test('a self-closing testcase never counts as a failure', (assert) => {
    // The shape every passing test has, and the one a greedy regex swallows into its neighbour.
    assert.deepEqual(failuresFrom('<testcase name="a" classname="b.ts"/>'), []);
  });

  test('an <error> counts too — a test that threw never reached an assertion', (assert) => {
    const found = failuresFrom(
      '<testcase name="threw" classname="b.ts"><error message="boom"/></testcase>',
    );

    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0]?.message, 'boom');
  });

  test('a message in the element text is read where there is no attribute', (assert) => {
    const found = failuresFrom(
      '<testcase name="x" classname="b.ts"><failure>\n  AssertionError: nope\n</failure></testcase>',
    );

    assert.strictEqual(found[0]?.message, 'AssertionError: nope');
  });

  test('entities come back as characters, and only the first line is kept', (assert) => {
    const found = failuresFrom(
      '<testcase name="x &amp; y" classname="b.ts">' +
        '<failure message="expected &quot;a&quot;&#10;  at b.ts:12"/></testcase>',
    );

    assert.strictEqual(found[0]?.name, 'x & y');
    assert.strictEqual(found[0]?.message, 'expected "a"', 'the stack is not an annotation');
  });

  test('several suites in one document all report', (assert) => {
    const found = failuresFrom(`<testsuites>
      <testsuite name="a.ts"><testcase name="one" classname="a.ts"><failure message="x"/></testcase></testsuite>
      <testsuite name="b.ts"><testcase name="two" classname="b.ts"><failure message="y"/></testcase></testsuite>
    </testsuites>`);

    assert.deepEqual(
      found.map((one) => one.name),
      ['one', 'two'],
    );
  });

  test('a document with nothing wrong in it is empty, not a throw', (assert) => {
    assert.deepEqual(failuresFrom('<testsuites/>'), []);
    assert.deepEqual(failuresFrom(''), []);
  });
});

module('Bin | annotating failures | the workflow command', { concurrency: true }, () => {
  test('the file becomes the annotation’s location', (assert) => {
    assert.strictEqual(
      asAnnotation({ file: 'a-test.ts', name: 'breaks', message: 'nope' }),
      '::error file=a-test.ts,title=a-test.ts::breaks — nope',
    );
  });

  test('a newline is encoded, because a raw one would end the command', (assert) => {
    const said = asAnnotation({ file: 'a.ts', name: 'x', message: 'one\ntwo' });

    assert.includes(said, '%0A');
    assert.notIncludes(said, '\n', 'nothing after it would be an annotation any more');
  });

  test('a percent is encoded before anything else, or the escapes eat each other', (assert) => {
    assert.includes(asAnnotation({ file: 'a.ts', name: 'x', message: '50% off' }), '50%25 off');
  });

  test('a testcase with no file still annotates, just without a location', (assert) => {
    assert.strictEqual(asAnnotation({ file: '', name: 'x', message: 'y' }), '::error ::x — y');
  });
});
