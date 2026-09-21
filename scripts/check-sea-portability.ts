import fs from 'node:fs/promises';
import process from 'node:process';

// Whether a built SEA binary can start on a machine that is not the one that built it.
//
// The release gate for exactly one bug, which shipped for months: a SEA built by copying
// `process.execPath` on NixOS names an ELF interpreter inside /nix/store, so `execve` fails in
// the kernel on every other distribution — no output, no stack, nothing to search for. The
// binary that was published to npm as qunitx-cli-linux-x64 ran on precisely one machine.
//
// Two things are read, and they are the two that decide whether it can start at all:
//
//   PT_INTERP    the dynamic loader the kernel is told to run. A path that does not exist is
//                the end of the story, before any library is looked for.
//   /nix/store   anywhere in the ELF headers, which is where RUNPATH and the library names live.
//                The appended SEA payload sits at the far end of the file and is not scanned.

/** How much of the file's front to scan for a store path — the headers, never the payload. */
const HEADER_BYTES = 1024 * 1024;

/** The interpreters a binary may name and still start on an ordinary distribution. */
const PORTABLE = [
  '/lib64/ld-linux-x86-64.so.2',
  '/lib/ld-linux-aarch64.so.1',
  '/lib/ld-linux-armhf.so.3',
  '/lib64/ld64.so.2',
  '/lib/ld-musl-x86-64.so.1',
  '/lib/ld-musl-aarch64.so.1',
];

/**
 * The dynamic loader an ELF binary names, or `null` where it names none.
 *
 * `null` covers both a static executable — which needs no loader and is portable by definition —
 * and a file that is not an ELF at all, which is what a macOS or Windows build is.
 *
 * ```ts
 * import { interpreterOf } from './check-sea-portability.ts';
 *
 * // Defined, not invoked: it reads a real file.
 * function example() {
 *   return interpreterOf('/bin/sh'); // '/lib64/ld-linux-x86-64.so.2' on a glibc x64 box
 * }
 * ```
 */
export async function interpreterOf(file: string): Promise<string | null> {
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(64);
    await handle.read(header, 0, header.length, 0);
    if (header.readUInt32BE(0) !== 0x7f454c46) return null;
    // 64-bit little-endian is every target this publishes; anything else is a build nobody asked
    // for, and guessing at its header layout would be worse than saying so.
    if (header[4] !== 2 || header[5] !== 1) {
      throw new Error(`${file} is an ELF this cannot read (class ${header[4]}, data ${header[5]})`);
    }
    const phoff = Number(header.readBigUInt64LE(0x20));
    const phentsize = header.readUInt16LE(0x36);
    const phnum = header.readUInt16LE(0x38);

    const table = Buffer.alloc(phentsize * phnum);
    await handle.read(table, 0, table.length, phoff);
    for (let at = 0; at < phnum; at++) {
      const entry = table.subarray(at * phentsize, (at + 1) * phentsize);
      if (entry.readUInt32LE(0) !== 3) continue; // PT_INTERP

      const offset = Number(entry.readBigUInt64LE(0x08));
      const size = Number(entry.readBigUInt64LE(0x20));
      const interp = Buffer.alloc(size);
      await handle.read(interp, 0, size, offset);

      return interp.toString('utf8').replace(/\0.*$/, '');
    }

    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Whether an interpreter path is one an ordinary distribution provides.
 *
 * `null` — no interpreter — is portable: a static binary needs no loader, and a non-ELF file is
 * not this check's business.
 *
 * ```ts
 * import { isPortableInterpreter } from './check-sea-portability.ts';
 *
 * isPortableInterpreter('/lib64/ld-linux-x86-64.so.2'); // true
 * isPortableInterpreter(null); // true — static, or not an ELF
 * isPortableInterpreter('/nix/store/m07h-glibc-2.42/lib/ld-linux-x86-64.so.2'); // false
 * ```
 */
export function isPortableInterpreter(interpreter: string | null): boolean {
  return interpreter === null || PORTABLE.includes(interpreter);
}

/**
 * Whether a built binary will start anywhere, and what is wrong with it if not.
 *
 * ```ts
 * import { checkPortability } from './check-sea-portability.ts';
 *
 * // Defined, not invoked: it reads a real file.
 * function example() {
 *   return checkPortability('npm/linux-x64/bin/qunitx'); // { portable, interpreter, problems }
 * }
 * ```
 */
export async function checkPortability(file: string): Promise<{
  portable: boolean;
  interpreter: string | null;
  problems: string[];
}> {
  const interpreter = await interpreterOf(file);
  const problems: string[] = [];

  if (!isPortableInterpreter(interpreter)) {
    problems.push(
      `its ELF interpreter is ${interpreter} — the kernel will not find that anywhere else, ` +
        'so `execve` fails before any of the binary runs',
    );
  }
  if (await namesTheStore(file)) {
    problems.push(
      'its ELF headers name /nix/store — a RUNPATH or a library from the machine that built it',
    );
  }

  return { portable: problems.length === 0, interpreter, problems };
}

/** Whether a store path appears in the headers, where RUNPATH and the library names live. */
async function namesTheStore(file: string): Promise<boolean> {
  const handle = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);

    return head.subarray(0, bytesRead).includes(Buffer.from('/nix/store'));
  } finally {
    await handle.close();
  }
}

// `node scripts/check-sea-portability.ts <file>` — the release gate. Says what is wrong and why
// it matters, because the failure it prevents is one with no error message of its own.
if (process.argv[1]?.endsWith('check-sea-portability.ts')) {
  const file = process.argv[2];
  if (file === undefined) {
    process.stderr.write('Usage: node scripts/check-sea-portability.ts <binary>\n');
    process.exit(2);
  }
  const verdict = await checkPortability(file);
  if (verdict.portable) {
    process.stdout.write(`portable: ${file} (interpreter ${verdict.interpreter ?? 'none'})\n`);
  } else {
    process.stderr.write(`NOT PORTABLE: ${file}\n`);
    for (const problem of verdict.problems) process.stderr.write(`  - ${problem}\n`);
    process.stderr.write(
      '\nThe SEA host must be an official build from nodejs.org, which is what\n' +
        '`node scripts/fetch-node-binary.ts` answers with. Copying this machine’s own\n' +
        '`process.execPath` is what produces a binary that runs only here.\n',
    );
    process.exit(1);
  }
}
