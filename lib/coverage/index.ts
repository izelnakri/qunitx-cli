// Barrel assembling the `Coverage` namespace: import * as Coverage from '.../coverage/index.ts'.
// A single-action file contributes a bare verb (Coverage.collect); a multi-operation file
// contributes a sub-namespace (Coverage.Report.write).
export { collect } from './collect.ts';
export * as Report from './report.ts';
