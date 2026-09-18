/**
 * One line saying why a command has no value to show, in the two ways there can be none: you named
 * nothing, or you named something this session does not have.
 *
 * The value-side twin of `reportBadPath`, and deliberately a plain string rather than something
 * that prints: `.doc`, `.copy` and `.type` each colour and place it differently, and all three
 * reach for it at the same moment — the one where their own answer came back `null`.
 *
 * The command comes first because that is the order it is read in and written in —
 * `noSuchValueLine('doc', argument)` is `.doc` speaking about what it was handed, the same shape
 * as `reportBadPath(repl, 'cat', …)`.
 *
 * ```ts
 * import { noSuchValueLine } from './no-such-value-line.ts';
 *
 * noSuchValueLine('doc', ''); // 'Usage: .doc <value>'
 * noSuchValueLine('doc', 'helper').includes('no such name'); // true — the other way
 * ```
 */
export function noSuchValueLine(command: string, argument: string): string {
  const asked = argument.trim();

  return asked === ''
    ? `Usage: .${command} <value>`
    : `nothing known about ${asked} — no such name in this session`;
}
