import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// The outside programs the recorder drives. All of them are in the nix devShell, and all of them
// can be built on demand from nixpkgs, so a checkout without them still records rather than
// telling you to go and install four things first.

/** A program as argv, so a wrapper — `steam-run <prog>` — fits the same slot as a bare path. */
export type Tool = readonly string[];

/** NixOS needs an FHS wrapper around Playwright's own Firefox build. Nothing else does. */
export const IS_NIXOS = existsSync('/etc/NIXOS');

/**
 * A program from PATH, else built from nixpkgs.
 *
 * ```ts
 * import { tool } from './tools.ts';
 *
 * tool('sh')[0]?.endsWith('sh'); // true
 * ```
 */
export function tool(name: string): Tool {
  const onPath = spawnSync('sh', ['-c', `command -v ${name}`])
    .stdout.toString()
    .trim();
  if (onPath) return [onPath];

  const built = spawnSync('nix', ['build', '--no-link', '--print-out-paths', `nixpkgs#${name}`]);
  if (built.status === 0) {
    return [path.join(built.stdout.toString().trim().split('\n')[0]!, 'bin', name)];
  }

  throw new Error(
    `${name} is needed to record the demo: put it on PATH (it is in the nix devShell)`,
  );
}

/** Runs one to completion, or says which one refused and with what. */
export function run(program: Tool, args: readonly string[], cwd: string): void {
  const [command, ...prefix] = program;
  const result = spawnSync(command!, [...prefix, ...args], { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
  }
}
