import { module, test } from 'qunitx';
// @ts-expect-error — module produced at build time by the package.json plugin.
import { GREETING } from 'virtual:greeting';

module('package.json plugins', () => {
  test('virtual module produced by a factory plugin loads and respects its options', (assert) => {
    assert.equal(GREETING, 'hello from package.json');
  });
});
