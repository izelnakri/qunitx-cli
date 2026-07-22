// Barrel assembling the `Args` namespace: import * as Args from '.../args/index.ts'.
export { parse, InvalidFlag } from './parse.ts';
export type { ParseFailure } from './parse.ts';
export { tokenize } from './tokenize.ts';
export type { ArgToken, QueryToken, FlagToken, InputToken } from './tokenize.ts';
