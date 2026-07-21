import { module, test } from 'qunitx';

module('{{moduleName}} Before script web server tests', function (_hooks) {
  test('assert true works', async function (assert) {
    let json;
    try {
      await wait(250);

      const res = await fetch('/films');
      json = await res.json();
    } catch (err) {
      console.log('FETCH ERR', err);
      console.log(err.cause);
    }

    assert.deepEqual(json, { film: 'responsed correctly' });
  });
});

function wait(duration) {
  return new Promise((resolve) =>
    setTimeout(() => {
      resolve();
    }, duration),
  );
}
