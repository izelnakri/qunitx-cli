// Barrel for the Stream leg of the error system.
//
//   import { Stream } from '.../lib/stream/index.ts';
//
// One system, three shapes, one failure vocabulary: `Result` is a settled outcome, `Task` a
// future outcome, `Stream` many outcomes over time — elements are the bare `T | E` union,
// terminal consumers return Tasks, and `Failure` is the single error currency throughout.
export {
  Stream,
  ChannelOverflow,
  type Channel,
  type ChannelOptions,
  type ChannelOverflowFailure,
  type Overflow,
  type Source,
} from './stream.ts';

export { Task } from '../task/task.ts';

/**
 * Structured, discriminable failures — the `E` elements of a Stream.
 *
 * ```ts
 * import * as Failure from '../result/failure.ts';
 * const Late = Failure.define('Late', (d: { ms: number }) => `arrived ${d.ms}ms late`);
 * Late.is(Late({ ms: 250 })); // true
 * ```
 */
export * as Failure from '../result/failure.ts';
