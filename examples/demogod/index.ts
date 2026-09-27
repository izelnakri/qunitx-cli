// demogod — a GIF of a terminal, from a tape.
//
// You write a `.tape` (the storyboard: captions, keys, waits, pane switches) and a storyboard
// object (what the names in the tape mean), and demogod types the tape into a real terminal,
// records it, and stacks the panes into a GIF. It is the tool `make demo` in this repository uses
// to build docs/demo.gif — `scripts/make-demo-gif.ts` is a worked example of the whole API, and
// of what a set of pane recipes looks like.
//
// Three files, and they are readable in this order:
//
//   tape.ts        the language, and the clock: a `.tape` in, scenes out. Pure.
//   workspace.ts   the layout: which panes, how big, how they stack. Pure.
//   demo.ts        the machine: ttyd, a browser, ffmpeg, gifsicle.
//
// This is the MVP, living here so its API can be used in anger before it moves out into its own
// package. Nothing in it knows what is being demonstrated.

export { Demo, findProgram, runInFHS } from './demo.ts';
export type { CapturePane, Engine, Pane, Storyboard } from './demo.ts';

export {
  captionsOf,
  nominalMs,
  onTapeClock,
  panesOf,
  parseTape,
  TapeError,
  TYPING_MS,
  WAIT_HOLD_MS,
} from './tape.ts';
export type { Scene, Step, Timed } from './tape.ts';

export {
  measureWorkspace,
  paneOfKind,
  panesOfWorkspace,
  SIDE_BY_SIDE,
  stackFilter,
} from './workspace.ts';
export type {
  Dimensions,
  MeasuredPane,
  MeasuredWorkspace,
  PaneKind,
  Workspace,
} from './workspace.ts';
