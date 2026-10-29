/**
 * Where the recording in this process has got to, for a run that stops without saying why: the
 * CLI's exit guard reports it.
 *
 * ```ts
 * import { progress } from './progress.ts';
 *
 * progress.phase; // 'not started', until record() is called
 * ```
 */
export const progress = { phase: 'not started' };
