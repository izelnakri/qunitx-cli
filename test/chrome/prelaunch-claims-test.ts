import { module, test } from 'qunitx';
import { claimPrelaunch, releasePrelaunch, shutdownPrelaunch } from '../../lib/chrome/prelaunch.ts';
import '../helpers/custom-asserts.ts';

// The pre-launched Chrome is PROCESS-global, and for years exactly one run used it — so the
// teardowns simply killed it. That is only safe while nothing shares a process: the moment two do,
// the first to finish reaps the browser the others are still connected to, and the symptom is a
// suite where a different test fails each time.
//
// Nothing here spawns Chrome. The reap is a no-op on a null handle, which is what makes the
// ARITHMETIC testable on its own — `releasePrelaunch` answers whether it was the one that reaped.
module('Chrome | prelaunch claims', () => {
  test('only the last holder reaps', async (assert) => {
    await shutdownPrelaunch(); // a known-zero starting point, whatever ran before
    claimPrelaunch();
    claimPrelaunch();

    assert.false(await releasePrelaunch(), 'the first release leaves it for the other holder');
    assert.true(await releasePrelaunch(), 'the second is the last one out, so it reaps');
  });

  test('releasing with nothing held reaps, so an unclaimed Chrome is still cleaned up', async (assert) => {
    // The drop-in property against the unconditional shutdown this replaced: a Chrome spawned but
    // never connected to — a run that fell back to chromium.launch(), or died in the bundler — is
    // still cleaned up by a bare release.
    await shutdownPrelaunch();

    assert.true(await releasePrelaunch(), 'no claims outstanding means this release is the last');
  });

  test('a hard shutdown resets the count', async (assert) => {
    // cli.ts's exit paths and launch()'s broken-CDP fallback take the browser out from under every
    // holder. Leaving the count behind would strand the next pre-launch behind phantom releases.
    await shutdownPrelaunch();
    claimPrelaunch();
    claimPrelaunch();
    await shutdownPrelaunch();

    claimPrelaunch();
    assert.true(await releasePrelaunch(), 'one claim after a shutdown needs exactly one release');
  });
});
