// A GIF decoder for asserting on what lib/record/gif.ts writes: every frame composited onto the
// one before it, the way a browser shows it. Written from the GIF89a spec, not from the encoder,
// so a bug the two shared would have to be made twice.

export interface DecodedGif {
  width: number;
  height: number;
  loops: boolean;
  frames: { rgba: Uint8Array; delayMs: number; rect: [number, number, number, number] }[];
}

export function decodeGif(bytes: Uint8Array): DecodedGif {
  let offset = 0;
  const u8 = () => bytes[offset++];
  const u16 = () => bytes[offset++] | (bytes[offset++] << 8);
  const header = String.fromCharCode(...bytes.subarray(0, 6));
  if (header !== 'GIF89a' && header !== 'GIF87a') throw new Error(`not a GIF: ${header}`);
  offset = 6;
  const width = u16();
  const height = u16();
  const packed = u8();
  offset += 2; // background color index, pixel aspect ratio
  const globalPalette = packed & 0x80 ? readPalette(2 << (packed & 7)) : null;

  const canvas = new Uint8Array(width * height * 4);
  const frames: DecodedGif['frames'] = [];
  let loops = false;
  let delayMs = 0;
  let transparent = -1;
  for (;;) {
    const block = u8();
    if (block === 0x3b) break;
    else if (block === 0x21) {
      const label = u8();
      const data = readSubBlocks();
      if (label === 0xf9) {
        delayMs = (data[1] | (data[2] << 8)) * 10;
        transparent = data[0] & 1 ? data[3] : -1;
      } else if (label === 0xff && String.fromCharCode(...data.subarray(0, 11)) === 'NETSCAPE2.0') {
        loops = true;
      }
    } else if (block === 0x2c) {
      const left = u16();
      const top = u16();
      const frameWidth = u16();
      const frameHeight = u16();
      const flags = u8();
      if (flags & 0x40) throw new Error('interlaced frames are not expected');
      const palette = flags & 0x80 ? readPalette(2 << (flags & 7)) : globalPalette;
      if (!palette) throw new Error('frame without a palette');
      const minCodeSize = u8();
      const indices = lzwDecode(readSubBlocks(), minCodeSize, frameWidth * frameHeight);
      for (let y = 0; y < frameHeight; y++) {
        for (let x = 0; x < frameWidth; x++) {
          const index = indices[y * frameWidth + x];
          if (index === transparent) continue;
          const target = ((top + y) * width + left + x) * 4;
          canvas.set(
            [palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2], 255],
            target,
          );
        }
      }
      frames.push({ rgba: canvas.slice(), delayMs, rect: [left, top, frameWidth, frameHeight] });
      transparent = -1;
    } else {
      throw new Error(`unexpected block 0x${block.toString(16)} at ${offset - 1}`);
    }
  }
  return { width, height, loops, frames };

  function readPalette(entries: number): Uint8Array {
    const palette = bytes.subarray(offset, offset + entries * 3);
    offset += entries * 3;
    return palette;
  }

  function readSubBlocks(): Uint8Array {
    const parts: number[] = [];
    for (let size = u8(); size !== 0; size = u8()) {
      for (let index = 0; index < size; index++) parts.push(u8());
    }
    return Uint8Array.from(parts);
  }
}

function lzwDecode(data: Uint8Array, minCodeSize: number, pixels: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out = new Uint8Array(pixels);
  let written = 0;
  let width = minCodeSize + 1;
  let dictionary: number[][] = [];
  const reset = () => {
    dictionary = Array.from({ length: end + 1 }, (_, code) => (code < clear ? [code] : []));
    width = minCodeSize + 1;
  };
  reset();
  let previous: number[] | null = null;
  let bitOffset = 0;
  // The next code, `width` bits LSB first; null once the data runs out.
  const readCode = (): number | null => {
    if (bitOffset + width > data.length * 8) return null;
    let code = 0;
    for (let bit = 0; bit < width; bit++, bitOffset++) {
      code |= ((data[bitOffset >> 3] >> (bitOffset & 7)) & 1) << bit;
    }
    return code;
  };
  for (let code = readCode(); code !== null && code !== end; code = readCode()) {
    if (code === clear) {
      reset();
      previous = null;
      continue;
    }
    let entry: number[];
    if (code < dictionary.length) entry = dictionary[code];
    else if (code === dictionary.length && previous) entry = [...previous, previous[0]];
    else throw new Error(`bad LZW code ${code} (dictionary has ${dictionary.length})`);
    for (const value of entry) if (written < pixels) out[written++] = value;
    if (previous && dictionary.length < 4096) dictionary.push([...previous, entry[0]]);
    if (dictionary.length === 1 << width && width < 12) width++;
    previous = entry;
  }
  if (written !== pixels) throw new Error(`LZW produced ${written} of ${pixels} pixels`);
  return out;
}
