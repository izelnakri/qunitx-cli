import { module, test } from 'qunitx';
// @ts-expect-error — the specifiers below resolve through this fixture's own package.json, deno.json
// and import map, which `deno check` (run from the repo root) does not read.
import { apply, Operation } from '#math';
// @ts-expect-error — see above.
import { greet } from 'no-bundle-fixture/greet';
// @ts-expect-error — see above.
import { capitalize } from '@app/strings.ts';
// `.js` written for a `.ts` file, the way `moduleResolution: nodenext` spells it.
// @ts-expect-error — `deno check` has no `.js`-means-`.ts` rule; a --no-bundle run does.
import { origin, type Point } from './helper.js';

module('no-bundle | resolution', () => {
  test('package.json#imports and an enum that needs a full transform', (assert) => {
    assert.equal(apply(Operation.Multiply, 6, 7), 42);
  });

  test('self-reference through exports, and package.json#qunitx.importMap', (assert) => {
    assert.equal(greet('qunitx'), 'HELLO QUNITX!');
  });

  test('deno.json imports and a .js specifier for a .ts file', (assert) => {
    const point: Point = { ...origin, x: 1 };
    assert.equal(capitalize('native'), 'Native');
    assert.deepEqual(point, { x: 1, y: 0 });
  });

  test('a failing assertion points at this file', (assert) => {
    assert.equal(apply(Operation.Add, 1, 1), 3, 'deliberately wrong');
  });
});
