import { module, test } from 'qunitx';
import { navigate } from '../../lib/repl/navigate.ts';

// A REPL session has one page load to get right. On a loaded Windows runner that load failed with
// `net::ERR_NO_BUFFER_SPACE` — Winsock briefly out of buffers — and the whole session exited 1.
module('Repl | navigate', { concurrency: true }, () => {
  const OUT_OF_BUFFERS = 'page.goto: net::ERR_NO_BUFFER_SPACE at http://localhost:1234/';

  function pageFailing(times: number, message: string) {
    const page = {
      calls: 0,
      goto: () =>
        ++page.calls <= times ? Promise.reject(new Error(message)) : Promise.resolve(null),
    };

    return page;
  }

  test('a moment out of socket buffers is waited out', async (assert) => {
    const page = pageFailing(2, OUT_OF_BUFFERS);

    await navigate(page, 'http://localhost:1234/', { backoffMs: 0 });

    assert.strictEqual(page.calls, 3, 'two refusals, then the load');
  });

  test('anything else fails on the first attempt', async (assert) => {
    const page = pageFailing(1, 'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:1234/');

    await assert.rejects(navigate(page, 'http://localhost:1234/', { backoffMs: 0 }), /REFUSED/);
    assert.strictEqual(page.calls, 1, 'waiting does not fix a refused connection');
  });

  test('a machine that stays out of buffers is reported, not retried forever', async (assert) => {
    const page = pageFailing(Infinity, OUT_OF_BUFFERS);

    await assert.rejects(navigate(page, 'http://localhost:1234/', { backoffMs: 0 }), /NO_BUFFER/);
    assert.strictEqual(page.calls, 5, 'five attempts, then the error it kept getting');
  });
});
