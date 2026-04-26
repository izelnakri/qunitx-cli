import { module, test } from 'qunitx';
import '../helpers/custom-asserts.ts';
import shell from '../helpers/shell.ts';

// All three fixtures (.tsx React, .tsx Vue, .jsx) are bundled into ONE qunitx invocation.
// This means a single Chrome launch validates: default extension auto-discovery picks up
// .jsx + .tsx, esbuild's `jsx: 'automatic'` works for React, and the @jsxImportSource pragma
// re-routes the JSX import to vue/jsx-runtime — all in ~2 s of CI time.
module('JSX / TSX Input Tests', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('discovers .jsx + .tsx fixtures from a directory and renders React + Vue components', async (assert, testMetadata) => {
    const result = await shell('node cli.ts test/fixtures/jsx', {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.includes(result, 'TAP version 13');
    assert.tapResult(result, { testCount: 5 });

    assert.outputContains(result, {
      contains: [
        // React 19 — automatic runtime renders a function component into the DOM.
        /ok \d+ React 19 JSX \(\.tsx, automatic runtime\) \| renders a function component with JSX children \+ props # \(\d+ ms\)/,
        /ok \d+ React 19 JSX \(\.tsx, automatic runtime\) \| handles useState updates triggered by DOM events # \(\d+ ms\)/,
        // Vue 3 — @jsxImportSource pragma re-routes JSX into vue/jsx-runtime; mount + reactive update.
        /ok \d+ Vue 3 JSX \(\.tsx, @jsxImportSource vue\) \| mounts a Vue functional component using JSX # \(\d+ ms\)/,
        /ok \d+ Vue 3 JSX \(\.tsx, @jsxImportSource vue\) \| renders reactive state and reacts to DOM events # \(\d+ ms\)/,
        // Default extensions auto-discover .jsx (no --extensions flag passed).
        /ok \d+ \.jsx files are auto-discovered \(default extensions\) \| JSX automatic runtime produces a valid React element # \(\d+ ms\)/,
      ],
    });
  });
});
