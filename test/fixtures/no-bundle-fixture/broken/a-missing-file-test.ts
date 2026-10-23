import { module, test } from 'qunitx';
// @ts-expect-error — deliberately extensionless: the run reports it as a load failure.
import { capitalize } from '../lib/strings';

module('broken | extensionless', () => {
  test('never registers', (assert) => {
    assert.equal(capitalize('x'), 'X');
  });
});
