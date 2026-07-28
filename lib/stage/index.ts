// Barrel for the Stage leg: import * as Stage from '.../lib/stage/index.ts'.
//
// Elixir's GenStage — demand-driven, backpressured pipelines. A `Stream` is one lazy pull; a
// Stage is a live network where a producer fans out to many consumers that each pull at their own
// rate, unmet events buffer, and demand flows upstream so a slow consumer throttles a fast
// producer with no dropped event and no unbounded queue. Roles mirror GenStage: producer,
// consumer, producer_consumer, with a demand (work-sharing) or broadcast dispatcher.
export {
  producer,
  consumer,
  producerConsumer,
  tick,
  type Producer,
  type Consumer,
  type ProducerConsumer,
  type Events,
  type DispatcherKind,
} from './stage.ts';
