import { module, test } from 'qunitx';

// Tests run in real headless Chrome — not jsdom, not Node.js.

module('Browser', () => {
  test('has window, document & navigator', (assert) => {
    assert.ok(typeof window !== 'undefined', 'window exists');
    assert.ok(document.body !== null, 'document.body exists');
    assert.ok(navigator.userAgent.includes('Chrome'), 'running in Chrome');
  });

  test('can build and query a DOM tree', (assert) => {
    const ul = document.createElement('ul');
    ['Alice', 'Bob', 'Carol'].forEach((name) => {
      const li = document.createElement('li');
      li.textContent = name;
      ul.appendChild(li);
    });
    assert.equal(ul.querySelectorAll('li').length, 3);
    assert.equal(ul.querySelector('li').textContent, 'Alice');
  });

  test('crypto.randomUUID() works', (assert) => {
    const id = crypto.randomUUID();
    console.log('[debug] uuid:', id);
    assert.ok(/^[0-9a-f-]{36}$/.test(id), 'valid UUID format');
  });
});

module('Async', () => {
  test('resolves a promise', async (assert) => {
    const value = await Promise.resolve('hello from Chrome');
    assert.equal(value, 'hello from Chrome');
  });

  test('rejects are caught', async (assert) => {
    await assert.rejects(Promise.reject(new Error('boom')), /boom/);
  });
});

module('Assertions', () => {
  test('equal & deepEqual', (assert) => {
    assert.equal(1 + 1, 2);
    assert.deepEqual(
      { user: 'alice', roles: ['admin', 'viewer'] },
      { user: 'alice', roles: ['admin', 'viewer'] },
    );
  });

  test('throws on bad input', (assert) => {
    assert.throws(() => JSON.parse('{bad json}'), SyntaxError);
  });
});
