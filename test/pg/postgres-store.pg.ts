// Contract tests for the driver-injected Postgres store. Named `.pg.ts` (NOT `*-test.ts`) so the
// default runner and CI SKIP it; run explicitly with `npm run test:pg`. A recording driver logs
// (sql, params) and returns canned rows — verifying DISPATCH (right SQL, params, row-mapping) with
// NO database and NO dependency. Behavioral correctness against real Postgres is the opt-in pglite
// integration (portable, and it moves to actorboy with the store).
import { module, test } from 'qunitx';
import { postgresStore, postgresStoreSchema, type SqlExecutor } from '../../lib/node/postgres-store.ts';

function recorder(responses: Record<string, unknown[]> = {}) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const sql: SqlExecutor = {
    query: <Row>(text: string, params?: unknown[]) => {
      calls.push({ sql: text, params });
      const match = Object.keys(responses).find((needle) => text.includes(needle));
      return Promise.resolve((match ? responses[match] : []) as Row[]);
    },
  };
  return { sql, calls };
}

module('Node | postgresStore (driver-injected, no dependency)', () => {
  test('load maps the state column and binds the key', async (assert) => {
    const { sql, calls } = recorder({ 'SELECT state': [{ state: { n: 1 } }] });
    assert.deepEqual(await postgresStore(sql).load('jobs:1'), { n: 1 }, 'returns the row state');
    assert.true(calls[0].sql.includes('SELECT state'), 'issued a SELECT');
    assert.deepEqual(calls[0].params, ['jobs:1'], 'bound the key');
  });

  test('save UPSERTs the key with jsonb state', async (assert) => {
    const { sql, calls } = recorder();
    await postgresStore(sql).save('jobs:1', { n: 2 });
    assert.true(calls[0].sql.includes('ON CONFLICT'), 'an upsert');
    assert.true(calls[0].sql.includes('::jsonb'), 'casts to jsonb');
    assert.deepEqual(calls[0].params, ['jobs:1', JSON.stringify({ n: 2 })], 'key + serialized state');
  });

  test('clear DELETEs the key', async (assert) => {
    const { sql, calls } = recorder();
    await postgresStore(sql).clear('jobs:1');
    assert.true(calls[0].sql.includes('DELETE FROM'), 'a delete');
    assert.deepEqual(calls[0].params, ['jobs:1']);
  });

  test('claim uses FOR UPDATE SKIP LOCKED and returns the marked job states', async (assert) => {
    const { sql, calls } = recorder({
      'SKIP LOCKED': [{ state: { id: '1', state: 'executing' } }],
    });
    const claimed = await postgresStore(sql).claim!('jobs', 'default', ['available'], 1000, 5);
    assert.deepEqual(claimed, [{ id: '1', state: 'executing' }], 'returns claimed job states');
    assert.true(calls[0].sql.includes('SKIP LOCKED'), 'uses SKIP LOCKED');
    assert.deepEqual(
      calls[0].params,
      ['jobs:%', 'default', ['available'], 1000, 5],
      'prefix like + queue + ready + now + limit',
    );
  });

  test('lease uses the DB clock now() as authority, not the caller now', async (assert) => {
    const { sql, calls } = recorder({ RETURNING: [{ owner: 'a@c' }] });
    assert.equal(await postgresStore(sql).lease!('k', 'a@c', 999, 30000), 'a@c', 'the winning owner');
    assert.true(calls[0].sql.includes('now()'), 'expiry is compared against the DB clock');
    assert.deepEqual(
      calls[0].params,
      ['k', 'a@c', 30000],
      'key, candidate, ttl — the caller now (999) is NOT bound',
    );
  });

  test('rescue resets stale executing jobs and returns the count', async (assert) => {
    const { sql, calls } = recorder({ 'SET state': [{ key: 'jobs:1' }, { key: 'jobs:2' }] });
    assert.equal(await postgresStore(sql).rescue!('jobs', 5000), 2, 'returns the reset count');
    assert.true(calls[0].sql.includes("'executing'"), 'targets executing jobs');
    assert.deepEqual(calls[0].params, ['jobs:%', 5000]);
  });

  test('schema DDL names both tables', (assert) => {
    const ddl = postgresStoreSchema();
    assert.true(ddl.includes('qunitx_store'), 'the KV table');
    assert.true(ddl.includes('qunitx_leases'), 'the leases table');
    assert.true(ddl.includes('jsonb'), 'state is jsonb');
  });
});
