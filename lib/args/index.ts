// Barrel assembling the `Args` namespace: import * as Args from '.../args/index.ts'.
export { parse, applyInputs, InvalidFlag } from './parse.ts';
export type { ParseFailure, ParsedFlags } from './parse.ts';
export { tokenize } from './tokenize.ts';
export type { ArgToken, QueryToken, FlagToken, InputToken } from './tokenize.ts';
