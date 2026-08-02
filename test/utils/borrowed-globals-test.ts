import process from 'node:process';
import { module, test } from 'qunitx';
import { borrowArgv, borrowEnv } from '../../lib/utils/borrowed-globals.ts';

// Serial, not concurrent: every test here mutates process.argv or process.env, which two tests
// running at once would see each other's changes to.
module('Utils | borrowArgv', () => {
  test('swaps argv for the scope and restores the exact previous array', (assert) => {
    const before = process.argv;
    {
      using _argv = borrowArgv(['node', 'cli.ts', '--watch']);
      assert.deepEqual(process.argv, ['node', 'cli.ts', '--watch']);
    }
    assert.strictEqual(process.argv, before, 'the same array instance, not a copy');
  });

  test('restores when the scope exits by throwing', (assert) => {
    const before = process.argv;
    assert.throws(() => {
      using _argv = borrowArgv(['node', 'cli.ts', '--boom']);
      throw new Error('body failed');
    }, /body failed/);
    assert.strictEqual(process.argv, before, 'the failure did not keep the borrowed argv');
  });

  test('restores when the scope exits by returning early', (assert) => {
    const before = process.argv;
    const bail = (): string => {
      using _argv = borrowArgv(['node', 'cli.ts', '--early']);
      return 'bailed'; // the guard clause that a trailing restore would skip
    };
    assert.strictEqual(bail(), 'bailed');
    assert.strictEqual(process.argv, before);
  });

  test('nested borrows unwind in reverse order', (assert) => {
    const before = process.argv;
    {
      using _outer = borrowArgv(['node', 'cli.ts', 'outer']);
      {
        using _inner = borrowArgv(['node', 'cli.ts', 'inner']);
        assert.strictEqual(process.argv[2], 'inner');
      }
      assert.strictEqual(process.argv[2], 'outer', 'the inner scope gave back the outer value');
    }
    assert.strictEqual(process.argv, before);
  });
});

module('Utils | borrowEnv', () => {
  test('applies overrides for the scope and drops keys it added', (assert) => {
    const key = 'QUNITX_BORROW_TEST_ADDED';
    assert.strictEqual(process.env[key], undefined, 'precondition: the key is absent');
    {
      using _env = borrowEnv({ [key]: 'set' });
      assert.strictEqual(process.env[key], 'set');
    }
    assert.strictEqual(
      process.env[key],
      undefined,
      'a key that did not exist is deleted, not blanked',
    );
    assert.false(key in process.env, 'and the key itself is gone');
  });

  test('restores a pre-existing value rather than deleting it', (assert) => {
    const key = 'QUNITX_BORROW_TEST_EXISTING';
    process.env[key] = 'original';
    try {
      {
        using _env = borrowEnv({ [key]: 'borrowed' });
        assert.strictEqual(process.env[key], 'borrowed');
      }
      assert.strictEqual(process.env[key], 'original');
    } finally {
      delete process.env[key];
    }
  });

  test('undoes writes the body made, not just the ones it was given', (assert) => {
    const key = 'QUNITX_BORROW_TEST_BODY_WRITE';
    {
      using _env = borrowEnv({});
      process.env[key] = 'written by a before-hook';
    }
    assert.strictEqual(
      process.env[key],
      undefined,
      "a run's own env writes do not bleed into the next",
    );
  });

  test('an undefined override is ignored rather than written as "undefined"', (assert) => {
    const key = 'QUNITX_BORROW_TEST_UNDEFINED';
    {
      using _env = borrowEnv({ [key]: undefined });
      assert.false(key in process.env, 'no key is created for an absent client value');
    }
    assert.strictEqual(process.env[key], undefined);
  });

  test('keeps the live process.env binding rather than replacing the object', (assert) => {
    const before = process.env;
    {
      using _env = borrowEnv({ QUNITX_BORROW_TEST_IDENTITY: '1' });
      assert.strictEqual(process.env, before, 'the same object during the scope');
    }
    assert.strictEqual(process.env, before, 'and after — modules holding a reference still see it');
  });

  test('restores when the scope exits by throwing', (assert) => {
    const key = 'QUNITX_BORROW_TEST_THROW';
    assert.throws(() => {
      using _env = borrowEnv({ [key]: 'leaked?' });
      throw new Error('body failed');
    }, /body failed/);
    assert.strictEqual(process.env[key], undefined);
  });
});

// The shape the daemon actually uses, and the one that was leaking: two globals borrowed
// together, then the body throws. Restoring one and forgetting the other is the bug `using`
// removes — the argv `finally` used to run while env stayed on the daemon for every later run.
module('Utils | borrowed globals together', () => {
  test('both are given back when the body throws', (assert) => {
    const argvBefore = process.argv;
    const key = 'QUNITX_BORROW_TEST_PAIR';

    assert.throws(() => {
      using _env = borrowEnv({ [key]: 'client value' });
      using _argv = borrowArgv(['node', 'cli.ts', '--from-client']);
      throw new Error('Config.setup() blew up');
    }, /Config.setup/);

    assert.strictEqual(process.argv, argvBefore, 'argv restored');
    assert.strictEqual(process.env[key], undefined, 'and env too — the half that used to leak');
  });
});
