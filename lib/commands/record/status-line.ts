import { cyan } from '../../utils/color.ts';
import { progress } from '../../record/progress.ts';

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const BAR_WIDTH = 20;
const REDRAW_MS = 100;

/**
 * The line `qunitx record` keeps redrawing on a terminal while it records: what it is doing, how
 * long it has taken, and a bar where the phase knows how far along it is. Cut to the terminal's
 * width, as a line that wraps can no longer be redrawn in place.
 *
 * ```ts
 * import * as StatusLine from './status-line.ts';
 *
 * StatusLine.render({ phase: 'encoding demo.gif', done: 48, total: 96 }, 12_300, 80, 0);
 * // '⠋ encoding demo.gif ▕██████████░░░░░░░░░░▏ 50%  12.3s'
 * ```
 */
export function render(
  state: { phase: string; done: number; total: number | null },
  elapsedMs: number,
  columns: number,
  tick: number,
): string {
  const bar = state.total ? ` ${renderBar(state.done / state.total)}` : '';
  const text = `${state.phase}${bar}  ${(elapsedMs / 1000).toFixed(1)}s`;
  return `${SPINNER[tick % SPINNER.length]} ${text.slice(0, Math.max(columns - 3, 0))}`;
}

/**
 * Shows the recording's progress on `stream` until the returned function is called, which erases
 * the line, so what is printed next starts on a clean one.
 *
 * ```ts
 * import * as StatusLine from './status-line.ts';
 *
 * // Defined, not invoked: draws on the terminal.
 * async function recordWithProgress(recording: Promise<unknown>) {
 *   const hide = StatusLine.show(process.stderr);
 *   return await recording.finally(hide);
 * }
 * ```
 */
export function show(stream: { write(text: string): unknown; columns?: number }): () => void {
  const startedAt = performance.now();
  let tick = 0;
  const draw = () => {
    const line = render(progress, performance.now() - startedAt, stream.columns || 80, tick++);
    stream.write(`\r\x1b[2K${cyan(line.slice(0, 1))}${line.slice(1)}`);
  };
  const timer = setInterval(draw, REDRAW_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    stream.write('\r\x1b[2K');
  };
}

function renderBar(fraction: number): string {
  const filled = Math.round(Math.min(Math.max(fraction, 0), 1) * BAR_WIDTH);
  const percent = Math.floor(Math.min(Math.max(fraction, 0), 1) * 100);
  return `▕${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}▏ ${percent}%`;
}
