import { Buffer } from 'node:buffer';

/**
 * The smallest ELF64 file that names a dynamic loader — 121 bytes plus the path.
 *
 * Written by hand so the portability tests can state the case that matters without a fixture: the
 * binary this repo published for months was 73MB, and the one thing wrong with it was the string
 * in its `PT_INTERP` segment. A crafted header carries exactly that string and nothing else.
 *
 * The kernel will refuse to run it — there are no `PT_LOAD` segments — which is the other half of
 * what it is for: `spawn` on this file fails the same way it fails on a real binary whose loader
 * is missing, so the launcher's fallback can be tested without a 73MB file that only breaks on
 * other people's machines.
 *
 * ```ts
 * import { elfNaming } from './tiny-elf.ts';
 *
 * elfNaming('/lib64/ld-linux-x86-64.so.2').length; // 148
 * elfNaming('/x').readUInt32BE(0).toString(16); // '7f454c46' — the ELF magic
 * ```
 */
export function elfNaming(interpreter: string): Buffer {
  const HEADER = 64;
  const PROGRAM_HEADER = 56;
  const path = Buffer.from(`${interpreter}\0`, 'utf8');
  const file = Buffer.alloc(HEADER + PROGRAM_HEADER + path.length);

  // e_ident: magic, 64-bit, little-endian, current version, System V.
  file.writeUInt32BE(0x7f454c46, 0);
  file[4] = 2;
  file[5] = 1;
  file[6] = 1;

  file.writeUInt16LE(2, 0x10); // e_type: ET_EXEC
  file.writeUInt16LE(0x3e, 0x12); // e_machine: x86-64
  file.writeUInt32LE(1, 0x14); // e_version
  file.writeBigUInt64LE(BigInt(HEADER), 0x20); // e_phoff
  file.writeUInt16LE(HEADER, 0x34); // e_ehsize
  file.writeUInt16LE(PROGRAM_HEADER, 0x36); // e_phentsize
  file.writeUInt16LE(1, 0x38); // e_phnum

  const program = HEADER;
  file.writeUInt32LE(3, program + 0x00); // p_type: PT_INTERP
  file.writeUInt32LE(4, program + 0x04); // p_flags: read
  file.writeBigUInt64LE(BigInt(HEADER + PROGRAM_HEADER), program + 0x08); // p_offset
  file.writeBigUInt64LE(BigInt(path.length), program + 0x20); // p_filesz
  file.writeBigUInt64LE(BigInt(path.length), program + 0x28); // p_memsz
  file.writeBigUInt64LE(1n, program + 0x30); // p_align

  path.copy(file, HEADER + PROGRAM_HEADER);

  return file;
}
