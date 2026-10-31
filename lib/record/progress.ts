/**
 * Where the recording in this process has got to: the CLI shows it while it records, and its exit
 * guard reports it for a run that stops without saying why. `done` of `total` is how far along the
 * phase is, where that is known; `total` is null where it is not, as while a tour runs.
 *
 * ```ts
 * import { progress } from './progress.ts';
 *
 * progress.phase; // 'not started', until record() is called
 * ```
 */
export const progress: { phase: string; done: number; total: number | null } = {
  phase: 'not started',
  done: 0,
  total: null,
};

/**
 * Starts a phase of the recording: `total` steps of it, when it is known how many.
 *
 * ```ts
 * import { enterPhase, progress } from './progress.ts';
 *
 * enterPhase('encoding demo.gif', 96);
 * progress.done += 1; // a frame encoded
 * [progress.phase, progress.done, progress.total]; // ['encoding demo.gif', 1, 96]
 * ```
 */
export function enterPhase(phase: string, total: number | null = null): void {
  progress.phase = phase;
  progress.done = 0;
  progress.total = total;
}
