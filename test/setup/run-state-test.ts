import { module, test } from 'qunitx';
import * as RunState from '../../lib/setup/run-state.ts';
import type { BuildState } from '../../lib/types.ts';

// Regression coverage for a stale filtered bundle surviving a watch-mode delete. The watcher
// used to clear only `allTestCode`, so `/filtered-tests.js` kept serving a bundle built from
// files that no longer existed — a rerun would execute tests from a deleted file.

function makeBuildState(): BuildState {
  return {
    allTestCode: 'ALL',
    filteredTestCode: 'FILTERED',
    htmlPathsToRunTests: ['/'],
    lastBuildErrored: false,
  };
}

module('Setup | RunState.clearBundles', { concurrency: true }, () => {
  test('clears the filtered bundle alongside the full one', (assert) => {
    const build = makeBuildState();

    RunState.clearBundles(build);

    assert.equal(build.allTestCode, null, 'allTestCode is dropped');
    assert.equal(
      build.filteredTestCode,
      undefined,
      'filteredTestCode is dropped too, so /filtered-tests.js cannot serve a stale bundle',
    );
  });

  test('leaves the surrounding build metadata intact', (assert) => {
    const build = makeBuildState();

    RunState.clearBundles(build);

    assert.deepEqual(build.htmlPathsToRunTests, ['/'], 'html run paths survive');
  });

  test('is idempotent on already-cleared bundles', (assert) => {
    const build = makeBuildState();

    RunState.clearBundles(build);
    RunState.clearBundles(build);

    assert.equal(build.allTestCode, null, 'stays cleared');
    assert.equal(build.filteredTestCode, undefined, 'stays cleared');
  });
});
