// Side-effect module: turns on V8's on-disk compile cache so subsequent module
// evaluations reuse cached bytecode. Must be the first import in cli.ts /
// runner.ts so the call lands before the heavy module graph compiles.
// Writes the active dir back to process.env so child spawns that use
// `...process.env` (daemon, test workers) also auto-enable from boot.
import module from 'node:module';

const result = module.enableCompileCache?.();
// `in` (not truthiness): preserves a user-set `NODE_COMPILE_CACHE=` (empty,
// meaning "disable in children") which would otherwise be overwritten.
if (result?.directory && !('NODE_COMPILE_CACHE' in process.env)) {
  process.env.NODE_COMPILE_CACHE = result.directory;
}
