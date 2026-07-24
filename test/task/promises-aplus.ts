/**
 * Runs the official Promises/A+ compliance suite (872 tests) against Task.
 *
 * A standalone runner rather than a *-test.ts file: the suite drives its own mocha instance,
 * which cannot nest inside the qunitx runner. Invoke with `npm run test:aplus`.
 *
 * The adapter is three one-liners because Task already IS a Promise — `withResolvers` is
 * exactly the `deferred()` shape the suite wants. What the suite actually proves is that the
 * laziness layer (`then()` starting the recipe before delegating to the native `then`) never
 * violates 2.2.x's ordering/immutability rules, and that a recipe-less externally-settled
 * Task behaves identically to a native promise.
 */
import promisesAplusTests from 'promises-aplus-tests';
import { Task } from '../../lib/task/index.ts';

// The suite deliberately settles deferreds before attaching handlers (the 2.2.6 late-attach
// cases), so node's unhandled/late-handled rejection warnings are the suite working as
// intended, not leaks. The mocha assertions are the oracle here.
process.on('unhandledRejection', () => {});
process.on('rejectionHandled', () => {});

const adapter = {
  resolved: (value: unknown) => Task.resolve(value),
  rejected: (reason: unknown) => Task.reject(reason),
  deferred: () => Task.withResolvers<unknown>(),
};

promisesAplusTests(adapter, { reporter: 'dot' }, (error: unknown) => {
  if (error) {
    // The runner reports the count of failed tests through the error's message; the mocha
    // output above already named them.
    console.error(`\nPromises/A+ suite failed: ${String(error)}`);
    process.exitCode = 1;
  } else {
    console.log('\nPromises/A+ suite: all tests passed.');
  }
});
