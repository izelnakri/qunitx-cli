import { module, test } from 'qunitx';
import { clearCachedBundles } from '../../../lib/commands/run/cached-bundles.ts';
import type { CachedContent } from '../../../lib/types.ts';

// Regression coverage for a stale filtered bundle surviving a watch-mode delete. The watcher
// used to clear only `allTestCode`, so `/filtered-tests.js` kept serving a bundle built from
// files that no longer existed — a rerun would execute tests from a deleted file.

function makeCachedContent(): CachedContent {
  return {
    allTestCode: 'ALL',
    filteredTestCode: 'FILTERED',
    assets: new Set(),
    htmlPathsToRunTests: ['/'],
    mainHTML: { filePath: null, html: null },
    staticHTMLs: {},
    dynamicContentHTMLs: {},
  };
}

module('Commands | run | clearCachedBundles', { concurrency: true }, () => {
  test('clears the filtered bundle alongside the full one', (assert) => {
    const cachedContent = makeCachedContent();

    clearCachedBundles(cachedContent);

    assert.equal(cachedContent.allTestCode, null, 'allTestCode is dropped');
    assert.equal(
      cachedContent.filteredTestCode,
      undefined,
      'filteredTestCode is dropped too, so /filtered-tests.js cannot serve a stale bundle',
    );
  });

  test('leaves the surrounding build metadata intact', (assert) => {
    const cachedContent = makeCachedContent();
    cachedContent.assets.add('/app.css');

    clearCachedBundles(cachedContent);

    assert.deepEqual([...cachedContent.assets], ['/app.css'], 'discovered assets survive');
    assert.deepEqual(cachedContent.htmlPathsToRunTests, ['/'], 'html run paths survive');
  });

  test('is idempotent on an already-cleared cache', (assert) => {
    const cachedContent = makeCachedContent();

    clearCachedBundles(cachedContent);
    clearCachedBundles(cachedContent);

    assert.equal(cachedContent.allTestCode, null, 'stays cleared');
    assert.equal(cachedContent.filteredTestCode, undefined, 'stays cleared');
  });
});
