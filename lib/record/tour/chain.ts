import { Task } from '../../task/index.ts';
import type { Page } from 'playwright-core';
import type { Tour, TourSteps, TourTab } from './index.ts';

// What makes a tour chainable: `await tour.goto(url).click('#buy').caption('Paid')` runs three
// steps under one `await`. Each step is a TourChain, a lazy Task: it runs when it is awaited, or
// when a step chained after it is, and only once the steps before it are done. So a chain is
// as sequential as the awaits it replaces, a failure skips the rest of its chain, and every Task
// method works on a step (`tour.click('#flaky').retry(2)` makes three attempts, no more).

/**
 * Every step of {@link TourSteps} by name, for TourChain to define a method per step. Checked at
 * compile time against the interface, so a step can't be added there and be missing here.
 *
 * ```ts
 * import { STEP_NAMES } from './chain.ts';
 *
 * STEP_NAMES.includes('click'); // true
 * ```
 */
export const STEP_NAMES = [
  'goto',
  'click',
  'tap',
  'hover',
  'rightClick',
  'longPress',
  'pinch',
  'move',
  'doubleClick',
  'select',
  'upload',
  'fill',
  'type',
  'press',
  'scroll',
  'drag',
  'swipe',
  'zoom',
  'zoomOut',
  'caption',
  'highlight',
  'chapter',
  'wait',
  'live',
  'snap',
  'open',
  'switchTo',
  'close',
] as const satisfies readonly (keyof TourSteps)[];

type StepName = (typeof STEP_NAMES)[number];
// Compiles only while every step of TourSteps is named above.
const _everyStepNamed: Exclude<keyof TourSteps, StepName> extends never ? true : never = true;

/**
 * Each step of `Steps`, taking the same arguments but returning a {@link TourChain} of what the
 * step resolves to, instead of a promise.
 *
 * ```ts
 * import type { Chained } from './chain.ts';
 *
 * type Steps = { wait(durationMs: number): Promise<void> };
 * type Chainable = Chained<Steps>; // { wait(durationMs: number): TourChain<void> }
 * ```
 */
export type Chained<Steps> = {
  [Name in keyof Steps]: Steps[Name] extends (...args: infer Args) => Promise<infer Value>
    ? (...args: Args) => TourChain<Value>
    : never;
};

/**
 * One step of a tour, and the steps chained before it: a lazy Task of what the step resolves to
 * (a {@link TourTab} for `open`, nothing for the rest), with every step as a method that chains
 * one more. Awaiting it runs the chain's steps in order, each after the one before is done.
 *
 * ```ts
 * import type { Tour } from './index.ts';
 *
 * // Defined, not invoked: a tour script.
 * async function checkout(tour: Tour) {
 *   await tour.goto('http://localhost:4200/').click('button.add-to-cart').caption('Added');
 *   const tab = await tour.open('http://localhost:4200/help'); // a step's value, as ever
 *   await tour.wait(500).switchTo(tour.tabs[0]).close(tab);
 * }
 * ```
 */
export class TourChain<T> extends Task<T> {
  readonly #queue: StepQueue;

  /**
   * Step `name` with `args`, chained after `previous` (null for the first of a chain), run on
   * `queue`. Scripts never call this: `tour.click(…)` and every step method of a chain do.
   *
   * ```ts
   * import { StepQueue, TourChain } from './chain.ts';
   * import type { TourSteps } from './index.ts';
   *
   * // Defined, not invoked: needs a running tour.
   * function waitThenCaption(run: TourSteps) {
   *   const wait = new TourChain<void>(new StepQueue(run), null, 'wait', [100]);
   *   return wait.caption('Done'); // the same as tour.wait(100).caption('Done')
   * }
   * ```
   */
  constructor(
    queue: StepQueue,
    previous: TourChain<unknown> | null,
    name: StepName,
    args: unknown[],
  ) {
    super(queue.recipe<T>(previous, name, args));
    this.#queue = queue;
  }

  static {
    for (const name of STEP_NAMES) {
      Object.defineProperty(this.prototype, name, {
        value: function (this: TourChain<unknown>, ...args: unknown[]) {
          return new TourChain(this.#queue, this, name, args);
        },
        writable: true,
        configurable: true,
      });
    }
  }
}

/**
 * The step methods TourChain defines on its prototype, as the types see them: each chains one
 * more step after this one.
 *
 * ```ts
 * import type { TourChain } from './chain.ts';
 *
 * // Defined, not invoked: a chain from a tour script.
 * const thenWait = (chain: TourChain<void>) => chain.wait(500);
 * ```
 */
export interface TourChain<T> extends Chained<TourSteps> {}

/**
 * Runs a tour's steps one at a time, whatever awaits them (two chains under one `Promise.all`
 * still take turns on the page), and remembers each step called, so a step nobody awaited is an
 * error rather than a silent gap in the recording.
 *
 * ```ts
 * import { StepQueue } from './chain.ts';
 * import type { TourSteps, TourTab } from './index.ts';
 * import type { Page } from 'playwright-core';
 *
 * // Defined, not invoked: needs a running tour.
 * async function script(run: TourSteps & { page: Page; tabs: TourTab[] }) {
 *   const queue = new StepQueue(run);
 *   await queue.tour(run).wait(100).caption('Done');
 *   queue.checkEveryStepRan(); // throws if a step was called but never awaited
 * }
 * ```
 */
export class StepQueue {
  readonly #steps: TourSteps;
  readonly #afterEachStep: (() => Promise<void>) | null;
  #tail: Promise<unknown> = Promise.resolve();
  readonly #called: { name: StepName; ran: boolean }[] = [];

  /**
   * A queue for the steps of one run; `afterEachStep`, when given, runs after every step that
   * succeeds, before the next one starts.
   *
   * ```ts
   * import { StepQueue } from './chain.ts';
   * import type { TourSteps } from './index.ts';
   *
   * // Defined, not invoked: needs a running tour.
   * const queueFor = (run: TourSteps) => new StepQueue(run);
   * ```
   */
  constructor(steps: TourSteps, afterEachStep: (() => Promise<void>) | null = null) {
    this.#steps = steps;
    this.#afterEachStep = afterEachStep;
  }

  /**
   * The work of step `name`, noted as called: once `previous` is done, the step itself, after
   * every step queued before it. A recipe, so a retry runs the step again; the chain before it is
   * a Task, which runs once however often it is awaited.
   *
   * ```ts
   * import { StepQueue } from './chain.ts';
   * import type { TourSteps } from './index.ts';
   *
   * // Defined, not invoked: needs a running tour.
   * async function waitTwice(run: TourSteps) {
   *   const wait = new StepQueue(run).recipe<void>(null, 'wait', [100]);
   *   await wait();
   *   await wait(); // a recipe runs every time it is called
   * }
   * ```
   */
  recipe<T>(
    previous: TourChain<unknown> | null,
    name: StepName,
    args: unknown[],
  ): () => Promise<T> {
    const call = { name, ran: false };
    this.#called.push(call);
    return async () => {
      call.ran = true;
      if (previous) await previous;
      return (await this.#run(name, args)) as T;
    };
  }

  /**
   * The `tour` a script is handed: `view` for the page and tabs, and each step as a method that
   * starts a chain.
   *
   * ```ts
   * import { StepQueue } from './chain.ts';
   * import type { TourSteps, TourTab } from './index.ts';
   * import type { Page } from 'playwright-core';
   *
   * // Defined, not invoked: needs a running tour.
   * async function intro(run: TourSteps & { page: Page; tabs: TourTab[] }) {
   *   const tour = new StepQueue(run).tour(run);
   *   await tour.goto('http://localhost:4200/').caption('Welcome');
   * }
   * ```
   */
  tour(view: { readonly page: Page; readonly tabs: readonly TourTab[] }): Tour {
    const tour = {
      get page() {
        return view.page;
      },
      get tabs() {
        return view.tabs;
      },
    } as Tour;
    for (const name of STEP_NAMES) {
      Object.defineProperty(tour, name, {
        value: (...args: unknown[]) => new TourChain(this, null, name, args),
      });
    }
    return tour;
  }

  /**
   * Throws naming the first step that was called but never awaited, so never ran: called once the
   * script is done, before the recording is drawn.
   *
   * ```ts
   * import { StepQueue } from './chain.ts';
   * import type { TourSteps, TourTab } from './index.ts';
   * import type { Page } from 'playwright-core';
   *
   * // Defined, not invoked: needs a running tour.
   * function forgotten(run: TourSteps & { page: Page; tabs: TourTab[] }) {
   *   const queue = new StepQueue(run);
   *   queue.tour(run).caption('never shown'); // not awaited
   *   queue.checkEveryStepRan(); // throws: tour.caption() was called but never awaited, …
   * }
   * ```
   */
  checkEveryStepRan(): void {
    const skipped = this.#called.find((call) => !call.ran);
    if (skipped) {
      throw new Error(
        `tour.${skipped.name}() was called but never awaited, so it never ran: ` +
          `await it, or chain it onto a step that is awaited`,
      );
    }
  }

  // One step, once every step queued before it has finished, failed or not.
  #run(name: StepName, args: unknown[]): Promise<unknown> {
    const step = this.#steps[name] as (...args: unknown[]) => Promise<unknown>;
    const result = this.#tail.then(async () => {
      const value = await step.apply(this.#steps, args);
      await this.#afterEachStep?.();
      return value;
    });
    this.#tail = result.catch(() => {});
    return result;
  }
}
