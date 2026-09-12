import { module, test } from 'qunitx';
import { candidates, declaration, importStatement, isIncomplete } from '../../lib/repl/source.ts';
import '../helpers/custom-asserts.ts';

module('Repl | source | candidates', { concurrency: true }, () => {
  test('ordinary input is evaluated exactly as typed', (assert) => {
    assert.deepEqual(candidates('1 + 1'), ['1 + 1']);
    assert.deepEqual(candidates('  await fetch("/x")  '), ['await fetch("/x")']);
    assert.deepEqual(candidates('let x = 1'), ['let x = 1']);
  });

  test('`{…}` is offered as an object first and a block second', (assert) => {
    // The ambiguity a REPL has to resolve: `{ a: 1 }` parses as a block with a label, which
    // evaluates to 1, and as an object, which is what anyone typing it meant.
    assert.deepEqual(candidates('{ a: 1 }'), ['({ a: 1 })', '{ a: 1 }']);
    assert.deepEqual(candidates('{}'), ['({})', '{}']);
  });

  test('a `{`-leading statement that is NOT an object still has its bare form to fall back on', (assert) => {
    assert.equal(candidates('{ let a = 1; }')[1], '{ let a = 1; }');
  });
});

module('Repl | source | isIncomplete', { concurrency: true }, () => {
  test('the parser running out of input means "keep reading"', (assert) => {
    for (const description of [
      'SyntaxError: Unexpected end of input',
      'SyntaxError: Unexpected end of script',
      'SyntaxError: Unterminated template literal',
      'SyntaxError: Unterminated string literal',
      'SyntaxError: Unterminated comment',
    ]) {
      assert.true(isIncomplete(description), description);
    }
  });

  test('a genuine syntax error is reported, not waited on', (assert) => {
    for (const description of [
      "SyntaxError: Unexpected token ';'",
      "SyntaxError: Unexpected identifier 'a'",
      'SyntaxError: Invalid or unexpected token',
      'ReferenceError: boom is not defined',
    ]) {
      assert.false(isIncomplete(description), description);
    }
  });
});

// At a breakpoint the page evaluates each input in a scope of its own and throws it away
// afterwards, so a `let` there answers `undefined` like a declaration should and then does not
// exist — the worst of both, because it looks like it worked.
module('Repl | source | declaration', { concurrency: true }, () => {
  test('the name and the value are read apart', (assert) => {
    // Apart, because they belong in different places: the value is evaluated where it was typed,
    // so it can see the frame, and the name is bound somewhere that outlasts the evaluation.
    assert.deepEqual(declaration('let me = { age: 32 }'), {
      name: 'me',
      value: '({ age: 32 })',
      blockScoped: true,
    });
  });

  test('the value keeps whatever was written, parenthesised', (assert) => {
    // `let doubled = answer * 2` has to see the frame's `answer`, and only the frame can.
    assert.strictEqual(declaration('const doubled = answer * 2')?.value, '(answer * 2)');
    assert.strictEqual(
      declaration('let a = { b: 1 };')?.value,
      '({ b: 1 })',
      'a literal, not a block',
    );
  });

  test('what the block owns, and what JavaScript hoists out of it', (assert) => {
    for (const keyword of ['let', 'const']) {
      assert.true(declaration(`${keyword} a = 1`)?.blockScoped, `${keyword} belongs to the block`);
    }

    assert.false(declaration('var a = 1')?.blockScoped, 'var is hoisted out of it');
    assert.true(declaration('class Person {}')?.blockScoped, 'a class belongs to the block');
    assert.false(declaration('function hello() {}')?.blockScoped, 'a function is hoisted out');
  });

  test('a named function or class keeps its name', (assert) => {
    assert.strictEqual(declaration('function hello() {}')?.name, 'hello');
    assert.strictEqual(declaration('async function hello() {}')?.name, 'hello');
    assert.strictEqual(declaration('function* hello() {}')?.name, 'hello');
    assert.strictEqual(declaration('class Person {}')?.name, 'Person');
    assert.strictEqual(
      declaration('function hello() {}')?.value,
      '(function hello() {})',
      'in parentheses, which is what makes a definition an expression',
    );
  });

  test('what is not a declaration is left alone', (assert) => {
    assert.strictEqual(declaration('me.age'), null);
    assert.strictEqual(declaration('1 + 1'), null);
    assert.strictEqual(declaration(''), null);
    assert.strictEqual(declaration('let a'), null, 'nothing is bound to anything');
  });

  test('unfinished input is not a declaration yet', (assert) => {
    // Treating it as one would turn "keep typing" into a syntax error.
    assert.strictEqual(declaration('let a = {'), null);
    assert.strictEqual(declaration('function hello() {'), null);
  });

  test('two names at once are left alone rather than half-understood', (assert) => {
    assert.strictEqual(declaration('let a = 1, b = 2'), null);
    assert.ok(declaration('let a = [1, 2]'), 'a comma inside something is not a second declarator');
    assert.ok(declaration('let a = f(1, 2)'), 'wherever the something is');
  });

  test('a destructuring pattern is left alone too', (assert) => {
    assert.strictEqual(declaration('const { a } = obj'), null, 'one name is read, or none');
  });
});

// A prompt is not a module, so the engine refuses the statement outright. Reading the clause is
// what lets the session do what it means instead.
module('Repl | source | importStatement', { concurrency: true }, () => {
  const read = (input: string) => {
    const found = importStatement(input);

    return found !== null && 'bindings' in found ? found : null;
  };
  const bound = (input: string) => read(input)?.bindings;
  const advice = (input: string) => {
    const found = importStatement(input);

    return found !== null && 'advice' in found ? found.advice : null;
  };

  test('a namespace import binds the module itself', (assert) => {
    const found = read("import * as A from './a.ts';");

    assert.strictEqual(found?.specifier, './a.ts');
    assert.deepEqual(
      found?.bindings,
      [{ name: 'A', from: null }],
      'null is the module, not a name',
    );
  });

  test('named imports bind what they name, renaming as asked', (assert) => {
    assert.deepEqual(bound("import { a, b as c } from 'x'"), [
      { name: 'a', from: 'a' },
      { name: 'c', from: 'b' },
    ]);
    assert.deepEqual(bound("import { default as d } from 'x'"), [{ name: 'd', from: 'default' }]);
  });

  test('a default import is the export called default', (assert) => {
    assert.deepEqual(bound("import D from 'x'"), [{ name: 'D', from: 'default' }]);
    assert.deepEqual(
      bound("import D, { a } from 'x'"),
      [
        { name: 'D', from: 'default' },
        { name: 'a', from: 'a' },
      ],
      'and it can be joined by the rest',
    );
    assert.deepEqual(bound("import D, * as N from 'x'"), [
      { name: 'D', from: 'default' },
      { name: 'N', from: null },
    ]);
  });

  test('an import for its side effects binds nothing, and is still an import', (assert) => {
    assert.deepEqual(importStatement("import './styles.css'"), {
      specifier: './styles.css',
      bindings: [],
    });
  });

  test('one plainly meant as an import comes back as advice, not as nothing', (assert) => {
    // Left as nothing it reaches the page, and the page answers every spelling with the same
    // `Cannot use import statement outside a module` — true of the working ones too, so it says
    // nothing about which this is.
    assert.strictEqual(
      advice("import A as * from './a.ts'"),
      "did you mean `import * as A from './a.ts'`?",
      'the one everybody writes from memory gets the line it was reaching for',
    );
    assert.includes(advice("import A from './a.ts") ?? '', 'needs the module in quotes');
    assert.includes(advice("import 3bad from './a.ts'") ?? '', 'cannot read that import');
    assert.strictEqual(advice("import * as A from './a.ts'"), null, 'a readable one is read');
    assert.strictEqual(advice('importantThing'), null, 'and a name that starts with it is a name');
  });

  test('a clause across several lines is one statement', (assert) => {
    // What the prompt hands over once the continuation is finished.
    assert.deepEqual(bound("import {\n  a,\n  b,\n} from './a.ts'"), [
      { name: 'a', from: 'a' },
      { name: 'b', from: 'b' },
    ]);
  });

  test('the function that already works is left alone', (assert) => {
    // `import()` is an expression the page evaluates itself; the space after the keyword is what
    // tells the declaration from it.
    assert.strictEqual(importStatement("await import('./a.ts')"), null);
    assert.strictEqual(importStatement('import(x)'), null);
    assert.strictEqual(
      importStatement('importantThing'),
      null,
      'nor is a name that starts with it',
    );
    assert.strictEqual(importStatement('1 + 1'), null);
  });
});
