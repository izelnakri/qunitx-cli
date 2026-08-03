/**
 * Benchmarks the future-outcome layer.
 *
 * A Task is a real Promise (`instanceof Promise` holds, the Promises/A+ suite passes) built
 * from a lazy recipe. That buys laziness, lineage and retry — and the cost of those has to
 * stay small enough that reaching for a Task instead of a Promise is never a performance
 * decision. Every group below pairs the Task spelling with its native equivalent so the
 * overhead is legible rather than asserted.
 *
 * The `create` group also pins the thing laziness is FOR: constructing a Task that is never
 * awaited must not run its recipe, so it should be far cheaper than the eager Promise it
 * replaces.
 */
import { Task } from '../lib/task/index.ts';
import * as Failure from '../lib/result/failure.ts';

const NotFound = Failure.define('NotFound', (data: { id: number }) => `no user ${data.id}`);
const double = (n: number) => n * 2;

// ── Construction: what a Task costs before anyone awaits it ───────────────────

Deno.bench('task: construct (recipe never run)', { group: 'create' }, () => {
  Task(() => 21);
});

Deno.bench('task: Promise.resolve for comparison', { group: 'create' }, () => {
  Promise.resolve(21);
});

Deno.bench('task: construct + three derivations, unawaited', { group: 'create' }, () => {
  Task(() => 21)
    .map(double)
    .map(double)
    .map(double);
});

// ── Awaiting: the run, once ───────────────────────────────────────────────────

Deno.bench('task: await a one-step task', { group: 'await' }, async () => {
  await Task(() => 21).map(double);
});

Deno.bench('task: await the native equivalent', { group: 'await' }, async () => {
  await Promise.resolve(21).then(double);
});

Deno.bench('task: await a three-step chain', { group: 'await' }, async () => {
  await Task(() => 21)
    .map(double)
    .map(double)
    .map(double);
});

Deno.bench('task: memoised second await (shares one run)', { group: 'await' }, async () => {
  const task = Task(() => 21).map(double);
  await task;
  await task;
});

// ── The failure path: declared failures settle, they do not throw ─────────────

Deno.bench('task: result() on a declared failure', { group: 'failure' }, async () => {
  await Task(() => NotFound({ id: 7 })).result();
});

Deno.bench('task: mapErr classifies a foreign error', { group: 'failure' }, async () => {
  await Task(() => {
    throw new Error('boom');
  })
    .mapErr(() => NotFound({ id: 7 }))
    .result();
});

// ── Combinators: the overridden statics, and their laziness ───────────────────

const TEN = Array.from({ length: 10 }, (_, index) => index);

Deno.bench('task: Task.all over 10 members', { group: 'combinators' }, async () => {
  await Task.all(TEN.map((n) => Task(() => n)));
});

Deno.bench('task: Promise.all over 10 members', { group: 'combinators' }, async () => {
  await Promise.all(TEN.map((n) => Promise.resolve(n)));
});

Deno.bench('task: Task.results keeps every outcome bare', { group: 'combinators' }, async () => {
  await Task.results(TEN.map((n) => Task(() => (n % 3 === 0 ? NotFound({ id: n }) : n))));
});

// ── Executor question: is `Task(recipe => new Promise(exec))` a viable substitute ──
// for a hypothetical `Task((resolve, reject, signal) => …)` constructor overload?
// These measure what the "executor via recipe" ergonomic actually costs vs a plain
// recipe, vs withResolvers, vs the native Promise executor it would wrap.

Deno.bench('exec: Task(recipe) — plain', { group: 'executor' }, async () => {
  await Task<number>(() => 21);
});

Deno.bench('exec: Task(signal => new Promise(exec))', { group: 'executor' }, async () => {
  await Task<number>(
    (_signal) => new Promise<number>((resolve) => resolve(21)),
  );
});

Deno.bench('exec: Task.withResolvers settle+await', { group: 'executor' }, async () => {
  const { promise, resolve } = Task.withResolvers<number>();
  resolve(21);
  await promise;
});

Deno.bench('exec: native new Promise(executor)', { group: 'executor' }, async () => {
  await new Promise<number>((resolve) => resolve(21));
});

// ── The Elixir family the port added — cost of the await/yield/shutdown surface ──

Deno.bench('elixir: Task.async then await()', { group: 'elixir' }, async () => {
  await Task.async(() => 21).await(1000);
});

Deno.bench('elixir: task.yield(ms) settled', { group: 'elixir' }, async () => {
  await Task(() => 21).yield(1000);
});

Deno.bench('elixir: task.await(ms) settled', { group: 'elixir' }, async () => {
  await Task(() => 21).await(1000);
});

Deno.bench('elixir: task.shutdown(ms) on settled', { group: 'elixir' }, async () => {
  await Task(() => 21).perform().shutdown(1000);
});

Deno.bench('elixir: Task.awaitMany over 10', { group: 'elixir' }, async () => {
  await Task.awaitMany(TEN.map((n) => Task(() => n)), 1000);
});

Deno.bench('elixir: Task.completed passthrough', { group: 'elixir' }, async () => {
  await Task.completed(21);
});

// ── Unified constructor: does arity dispatch cost anything? ───────────────────
// The constructor now reads `fn.length` once and stores a boolean. These pin that the
// recipe path is unchanged and that the executor path beats the `new Promise` it replaces.

Deno.bench('unified: Task(() => v) recipe', { group: 'unified' }, async () => {
  await Task<number>(() => 21);
});

Deno.bench('unified: Task((resolve) => resolve(v)) executor', { group: 'unified' }, async () => {
  await Task<number>((resolve) => resolve(21));
});

Deno.bench('unified: Task((r, j, signal) => promise)', { group: 'unified' }, async () => {
  await Task<number>((_resolve, _reject, _signal) => Promise.resolve(21));
});

Deno.bench('unified: Task(() => new Promise(exec)) old way', { group: 'unified' }, async () => {
  await Task<number>(() => new Promise<number>((resolve) => resolve(21)));
});

Deno.bench('unified: native new Promise(executor)', { group: 'unified' }, async () => {
  await new Promise<number>((resolve) => resolve(21));
});

Deno.bench('unified: construct executor, never awaited', { group: 'unified-create' }, () => {
  Task<number>((resolve) => resolve(21));
});

Deno.bench('unified: construct recipe, never awaited', { group: 'unified-create' }, () => {
  Task<number>(() => 21);
});

Deno.bench('unified: native Promise executor (eager)', { group: 'unified-create' }, () => {
  new Promise<number>((resolve) => resolve(21));
});
