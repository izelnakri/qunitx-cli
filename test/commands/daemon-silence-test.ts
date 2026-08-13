import { module, test } from 'qunitx';
import * as Client from '../../lib/commands/daemon/client.ts';
import { Failure } from '../../lib/result/index.ts';
import '../helpers/custom-asserts.ts';

// A daemon that accepts the connection and then says nothing is the shape behind the recurring
// crash-recovery hang: `dispatchRun` settles on a terminal chunk or on the socket closing, and a
// wedged daemon sends neither. The CI symptom was an empty stdout and a harness SIGTERM 150s
// later — no output, no error, nothing to diagnose.
//
// COVERAGE GAP, deliberately recorded rather than faked. The end-to-end path — stub a server on
// the daemon socket, stay silent, watch the client give up — needs `process.chdir()`, because the
// socket path is derived from the cwd and `dispatchRun` takes no cwd. Under the test worker that
// chdir does not take effect the way it does in a plain process, so the client connects somewhere
// else and the test hangs instead of failing. Proven by hand instead, and reproducible:
//
//   const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'silent-'));
//   await fs.mkdir(Paths.dir(dir), { recursive: true });
//   net.createServer(() => {}).listen(Paths.socket(dir));   // accepts, answers nothing
//   process.env.QUNITX_DAEMON_RUN_TIMEOUT = '400';
//   process.chdir(dir);
//   await Client.run({ inputs: ['x.ts'] }, silentConsole).result();
//   // -> DaemonSilent after 405ms, where it previously waited forever
//
// What is pinned below is everything that does not need the socket: the failure exists, says which
// of slow-vs-wedged it is, and the default budget cannot drift under the daemon's own deadline.
module('Daemon | Client | silence budget', { concurrency: true }, () => {
  test('the budget stays above the daemon’s own per-group deadline', (assert) => {
    // Below it, a group running down its 180s clock — legitimately silent — would be killed by the
    // client first, turning a run the daemon was about to fail properly into a transport error.
    assert.true(
      Client.RUN_SILENCE_TIMEOUT_MS > 180_000,
      `${Client.RUN_SILENCE_TIMEOUT_MS}ms leaves room for the daemon to report first`,
    );
  });

  test('the failure names silence, and tells the operator what to do about it', (assert) => {
    const failure = Client.DaemonSilent({ ms: 240_000 });

    assert.equal(failure.code, 'DaemonSilent', 'distinct from a disconnect — nothing was received');
    assert.includes(failure.message, '240s');
    assert.includes(failure.message, 'wedged, not slow');
    assert.includes(failure.message, '--no-daemon', 'and the way past it');
    assert.true(Failure.is(failure));
  });

  test('a sub-second budget reads in ms, so an override never prints "0s"', (assert) => {
    // The regression test above drives this path with a 400ms override; rounding to seconds
    // rendered it as "sent nothing for 0s", which reads as a bug in the message itself.
    assert.includes(Client.DaemonSilent({ ms: 400 }).message, '400ms');
  });
});
