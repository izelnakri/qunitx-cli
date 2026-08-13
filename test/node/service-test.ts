import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { defineService } from '../../lib/node/service.ts';
import { Failure } from '../../lib/result/index.ts';

const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));

// The contract — in real code an `import type` shared by both nodes; here inline. Only the TYPE and
// the string 'ledger' are the coupling; no code crosses the wire.
type LedgerApi = {
  debit: (arg: { account: string; amount: number }) => { balance: number };
  credit: (arg: { account: string; amount: number }) => { balance: number };
  balance: (arg: { account: string }) => number;
  fail: (arg: { account: string }) => number;
};

const Ledger = defineService<LedgerApi>('ledger');
const Insufficient = Failure.define('Insufficient', 'not enough funds');

const startLedger = (node: Node.NodeHandle) => {
  const balances = new Map<string, number>();
  Ledger.serve(node, {
    debit: ({ account, amount }) => {
      const next = (balances.get(account) ?? 0) - amount;
      balances.set(account, next);
      return { balance: next };
    },
    credit: ({ account, amount }) => {
      const next = (balances.get(account) ?? 0) + amount;
      balances.set(account, next);
      return { balance: next };
    },
    balance: ({ account }) => balances.get(account) ?? 0,
    // A declared failure returned from a handler crosses intact — it must arrive declared.
    fail: () => Insufficient() as unknown as number,
  });
};

module('Node | typed RPC (defineService)', () => {
  test('a direct-addressed call round-trips, typed end to end', async (assert) => {
    const hub = Node.memoryHub();
    const server = Node.start('srv@svc', hub.transport());
    const client = Node.start('cli@svc', hub.transport());
    startLedger(server);
    await settle();

    const ledger = Ledger.client(client, 'srv@svc');
    await ledger.credit({ account: 'alice', amount: 100 });
    const { balance } = await ledger.debit({ account: 'alice', amount: 30 });
    assert.strictEqual(balance, 70, 'the reply is the declared return shape');
    assert.strictEqual(await ledger.balance({ account: 'alice' }), 70, 'and reads back');

    server.stop();
    client.stop();
  });

  test('ctx.from carries the caller id, like node.handle', async (assert) => {
    const hub = Node.memoryHub();
    const server = Node.start('srv@svc', hub.transport());
    const client = Node.start('cli@svc', hub.transport());
    let sawFrom = '';
    defineService<{ who: (arg: null) => string }>('id').serve(server, {
      who: (_arg, ctx) => (sawFrom = ctx.from),
    });
    await settle();
    await defineService<{ who: (arg: null) => string }>('id').client(client, 'srv@svc').who(null);
    assert.strictEqual(sawFrom, 'cli@svc', 'the handler saw the calling node');
    server.stop();
    client.stop();
  });

  test('a declared failure from a handler crosses intact', async (assert) => {
    const hub = Node.memoryHub();
    const server = Node.start('srv@svc', hub.transport());
    const client = Node.start('cli@svc', hub.transport());
    startLedger(server);
    await settle();

    const outcome = await Ledger.client(client, 'srv@svc').fail({ account: 'x' }).result();
    assert.true(Failure.is(outcome), 'the bare-union result is a Failure');
    assert.strictEqual(
      (outcome as Failure.Any).code,
      'Insufficient',
      'declared code survived the wire',
    );
    server.stop();
    client.stop();
  });

  test("a 'via:' client routes to the ONE owner of a key", async (assert) => {
    const hub = Node.memoryHub();
    const owner = Node.start('owner@svc', hub.transport());
    const caller = Node.start('caller@svc', hub.transport());
    owner.register('accounts', 'main'); // own via:accounts/main
    startLedger(owner);
    await settle();

    const ledger = Ledger.client(caller, 'via:accounts/main');
    await ledger.credit({ account: 'bob', amount: 42 });
    assert.strictEqual(await ledger.balance({ account: 'bob' }), 42, 'routed to the key owner');
    owner.stop();
    caller.stop();
  });

  test("an unowned 'via:' key rejects with a declared NotRegistered", async (assert) => {
    const hub = Node.memoryHub();
    const caller = Node.start('caller@svc', hub.transport());
    const outcome = await Ledger.client(caller, 'via:accounts/ghost')
      .balance({ account: 'x' })
      .result();
    assert.true(Failure.is(outcome), 'unowned key is a declared failure, not a hang');
    assert.strictEqual((outcome as Failure.Any).code, 'NotRegistered');
    caller.stop();
  });

  test("a 'group:' client round-robins across members", async (assert) => {
    const hub = Node.memoryHub();
    const a = Node.start('a@svc', hub.transport());
    const b = Node.start('b@svc', hub.transport());
    const caller = Node.start('caller@svc', hub.transport());
    // Two members of group:pingers, each reporting its own name.
    defineService<{ who: (arg: null) => string }>('p').serve(a, { who: () => 'a@svc' });
    defineService<{ who: (arg: null) => string }>('p').serve(b, { who: () => 'b@svc' });
    a.join('pingers');
    b.join('pingers');
    await settle();

    const pinger = defineService<{ who: (arg: null) => string }>('p').client(
      caller,
      'group:pingers',
    );
    const seen = new Set<string>();
    for (let i = 0; i < 6; i += 1) seen.add(await pinger.who(null));
    assert.deepEqual(
      [...seen].sort(),
      ['a@svc', 'b@svc'],
      'both members were reached (round-robin)',
    );
    a.stop();
    b.stop();
    caller.stop();
  });

  test('a caster fires-and-forgets over node.cast', async (assert) => {
    const hub = Node.memoryHub();
    const server = Node.start('srv@svc', hub.transport());
    const client = Node.start('cli@svc', hub.transport());
    let got: unknown;
    defineService<{ note: (arg: string) => void }>('log').serve(server, {
      note: (msg) => void (got = msg),
    });
    await settle();
    defineService<{ note: (arg: string) => void }>('log').caster(client, 'srv@svc').note('hello');
    await settle();
    assert.strictEqual(got, 'hello', 'the cast reached the handler, no reply');
    server.stop();
    client.stop();
  });

  test('the client object is NOT thenable (the .then guard)', (assert) => {
    const hub = Node.memoryHub();
    const node = Node.start('n@svc', hub.transport());
    const client = Ledger.client(node, 'srv@svc') as unknown as { then?: unknown };
    assert.strictEqual(
      client.then,
      undefined,
      'awaiting the client itself must not hang or misbehave',
    );
    node.stop();
  });
});
