import { module, test } from 'qunitx';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

function Greeting({ name }: { name: string }) {
  return <h1 data-testid="greeting">Hello, {name}!</h1>;
}

function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button data-testid="counter" onClick={() => setCount((n) => n + 1)}>
      Count: {count}
    </button>
  );
}

module('React 19 JSX (.tsx, automatic runtime)', function (hooks) {
  let container: HTMLDivElement;
  let root: Root;

  hooks.beforeEach(function () {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  hooks.afterEach(function () {
    flushSync(() => root.unmount());
    container.remove();
  });

  test('renders a function component with JSX children + props', function (assert) {
    flushSync(() => root.render(<Greeting name="QUnitX" />));
    const node = container.querySelector('[data-testid="greeting"]');
    assert.ok(node, 'rendered element exists');
    assert.equal(node?.tagName, 'H1');
    assert.equal(node?.textContent, 'Hello, QUnitX!');
  });

  test('handles useState updates triggered by DOM events', function (assert) {
    flushSync(() => root.render(<Counter />));
    const button = container.querySelector('[data-testid="counter"]') as HTMLButtonElement;
    assert.equal(button.textContent, 'Count: 0', 'initial state');
    flushSync(() => button.click());
    assert.equal(button.textContent, 'Count: 1', 'updates after click');
    flushSync(() => button.click());
    assert.equal(button.textContent, 'Count: 2', 'further updates');
  });
});
