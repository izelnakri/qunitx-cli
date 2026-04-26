/** @jsxImportSource vue */
import { module, test } from 'qunitx';
import { createApp, defineComponent, ref, type App } from 'vue';

function Greeting(props: { name: string }) {
  return <h1 data-testid="greeting">Hello, {props.name}!</h1>;
}

const Counter = defineComponent({
  setup() {
    const count = ref(0);
    return () => (
      <button data-testid="counter" onClick={() => count.value++}>
        Count: {count.value}
      </button>
    );
  },
});

module('Vue 3 JSX (.tsx, @jsxImportSource vue)', function (hooks) {
  let container: HTMLDivElement;
  let app: App | null = null;

  hooks.beforeEach(function () {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  hooks.afterEach(function () {
    app?.unmount();
    app = null;
    container.remove();
  });

  test('mounts a Vue functional component using JSX', function (assert) {
    app = createApp(() => <Greeting name="QUnitX" />);
    app.mount(container);
    const node = container.querySelector('[data-testid="greeting"]');
    assert.ok(node, 'rendered element exists');
    assert.equal(node?.tagName, 'H1');
    assert.equal(node?.textContent, 'Hello, QUnitX!');
  });

  test('renders reactive state and reacts to DOM events', async function (assert) {
    app = createApp(Counter);
    app.mount(container);
    const button = container.querySelector('[data-testid="counter"]') as HTMLButtonElement;
    assert.equal(button.textContent?.trim(), 'Count: 0', 'initial state');

    button.click();
    // Vue flushes reactive updates on the next microtask.
    await Promise.resolve();
    assert.equal(button.textContent?.trim(), 'Count: 1', 'updates after click');
  });
});
