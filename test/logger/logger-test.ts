import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { logger, type LogLine } from '../../lib/logger/index.ts';

module('Logger | structured, trace-correlated', { concurrency: true }, () => {
  test('levels filter; metadata and base bindings merge into the line', (assert) => {
    const lines: LogLine[] = [];
    const log = logger({ level: 'info', sink: (l) => lines.push(l), base: { service: 'api' } });
    log.debug('below threshold');
    log.info('served', { status: 200, path: '/todos' });
    assert.equal(lines.length, 1, 'debug was dropped under the info threshold');
    assert.equal(lines[0].level, 'info');
    assert.equal(lines[0].msg, 'served');
    assert.equal(lines[0].service, 'api', 'base binding present');
    assert.equal(lines[0].status, 200, 'metadata present');
    assert.true(typeof lines[0].time === 'number');
  });

  test('child loggers fix bindings without mutating the parent', (assert) => {
    const lines: LogLine[] = [];
    const log = logger({ sink: (l) => lines.push(l), base: { service: 'api' } });
    const reqLog = log.child({ requestId: 'r-1' });
    reqLog.error('failed', { code: 500 });
    log.info('parent-line');
    assert.equal(lines[0].requestId, 'r-1', 'child carries its binding');
    assert.equal(lines[0].service, 'api', 'and the inherited base');
    assert.equal(lines[1].requestId, undefined, 'the parent is unaffected');
  });

  test('the ambient distributed trace id auto-attaches inside a handler', async (assert) => {
    const hub = Node.memoryHub();
    const a = Node.start('a@log', hub.transport());
    const b = Node.start('b@log', hub.transport());
    const lines: LogLine[] = [];
    // The logger reads the node's ambient trace — so a log inside the handler is correlated.
    const log = logger({ sink: (l) => lines.push(l), trace: () => b.trace() });
    b.handle('work', () => {
      log.info('handling work'); // ambient trace is live in the synchronous handler body
      return 'done';
    });

    await a.call('b@log', 'work');
    assert.equal(lines.length, 1);
    assert.true(
      typeof lines[0].traceId === 'string' && (lines[0].traceId as string).length > 0,
      'the log line carries the request-tree trace id, no app effort',
    );
    assert.true(typeof lines[0].span === 'string', 'and the hop span');
    a.stop();
    b.stop();
  });

  test('with no ambient trace, lines simply omit the trace fields', (assert) => {
    const lines: LogLine[] = [];
    const log = logger({ sink: (l) => lines.push(l), trace: () => undefined });
    log.info('no trace here');
    assert.equal(lines[0].traceId, undefined);
    assert.equal(lines[0].span, undefined);
  });
});
