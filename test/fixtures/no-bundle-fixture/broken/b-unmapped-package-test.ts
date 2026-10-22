import { module, test } from 'qunitx';
// @ts-expect-error — deliberately not installed: the run reports it as a load failure.
import leftPad from 'left-pad';

module('broken | unmapped package', () => {
  test('never registers', (assert) => {
    assert.equal(leftPad('1', 2, '0'), '01');
  });
});
