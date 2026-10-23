import { module, test } from 'qunitx';

module('broken | a sibling of broken files', () => {
  test('still runs', (assert) => {
    assert.ok(true);
  });
});
