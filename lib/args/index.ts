// Barrel assembling the `Args` namespace: import * as Args from '.../args/index.ts'.
export { parse } from './parse-cli-flags.ts';
export { tokenize } from './tokenize-args.ts';
export type { ArgToken, QueryToken, FlagToken, InputToken } from './tokenize-args.ts';
