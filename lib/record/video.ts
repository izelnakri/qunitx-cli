import { Buffer } from 'node:buffer';
import * as Capture from './capture.ts';
import * as MP4 from './mp4.ts';
import * as Outputs from './outputs.ts';
import * as WebM from './webm.ts';
import type { RecordedFile } from './index.ts';
import type { BrowserContext } from 'playwright-core';

// The page encoding runs in. WebCodecs exists only in a secure context, and `localhost` is one in
// every engine; the request never leaves the browser, it is answered by a route.
const ENCODER_URL = 'http://localhost/__qunitx_encoder__';
// Codec strings tried in order, per container, until the engine says it can encode one at this size.
// H.264 levels go up because a level caps the frame size: 3.1 stops at 1280×720.
const CANDIDATES: Record<Container, string[]> = {
  webm: ['vp09.00.10.08', 'vp8'],
  mp4: ['avc1.42001f', 'avc1.4d0028', 'avc1.640033', 'avc1.640034'],
};
// A keyframe at least this often, so a player can seek without decoding from the start.
const KEYFRAME_EVERY_MS = 2000;
// Runs in the encoder page, kept as source because lib/ is typechecked without the DOM library.
const ENCODER_SOURCE = `(() => {
  const NAMES = { avc1: 'h264', vp09: 'vp9', vp8: 'vp8', av01: 'av1' };
  const messageOf = (error) => String(error?.message ?? error);
  const toBytes = (base64) => {
    if (Uint8Array.fromBase64) return Uint8Array.fromBase64(base64);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  };
  const toBase64 = (bytes) => {
    if (bytes.toBase64) return bytes.toBase64();
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  };
  // H.264 needs even sides: an odd one loses its last row or column, which beats a black line.
  const sizeFor = (codec, width, height) =>
    codec.startsWith('avc1')
      ? { width: Math.max(2, width & ~1), height: Math.max(2, height & ~1) }
      : { width, height };
  const configFor = (codec, { width, height }, fps) => ({
    codec,
    width,
    height,
    framerate: fps,
    bitrate: Math.max(500_000, Math.round(width * height * fps * 0.2)),
    ...(codec.startsWith('avc1') ? { avc: { format: 'avc' } } : {}),
  });
  const supported = (config) =>
    VideoEncoder.isConfigSupported(config).then((support) => support.supported, () => false);
  // A decoder configuration (H.264's avcC) as bytes of its own: the encoder may reuse its buffer.
  const copyOf = (description) =>
    description === undefined
      ? null
      : ArrayBuffer.isView(description)
        ? new Uint8Array(description.buffer.slice(description.byteOffset, description.byteOffset + description.byteLength))
        : new Uint8Array(description);
  const reordered = (video) =>
    video.chunks.some((chunk, index) => index > 0 && chunk.timestamp < video.chunks[index - 1].timestamp);
  // Backpressure: never more than a handful of frames queued inside an encoder.
  const drained = async (videos) => {
    for (; videos.some((video) => video.encoder.encodeQueueSize > 4); ) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };

  // The first candidate this engine can encode at this size, as an encoder of its own; or why none.
  async function open({ container, candidates }, width, height, fps) {
    for (const codec of candidates) {
      const config = configFor(codec, sizeFor(codec, width, height), fps);
      if (await supported(config)) return startEncoder(codec, config);
    }
    const codecs = container === 'mp4' ? 'H.264 for .mp4' : 'VP9 or VP8 for .webm';
    return 'this browser cannot encode ' + codecs + ' at ' + width + '×' + height;
  }

  // An encoder and the canvas it draws on, collecting its chunks as they come out.
  function startEncoder(codec, config) {
    const canvas = new OffscreenCanvas(config.width, config.height);
    const video = { codec: NAMES[codec.split('.')[0]], canvas, context: canvas.getContext('2d'), description: null, chunks: [], error: null };
    video.encoder = new VideoEncoder({
      output(chunk, metadata) {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        video.description ??= copyOf(metadata?.decoderConfig?.description);
        video.chunks.push({ data, timestamp: chunk.timestamp, key: chunk.type === 'key' });
      },
      error(error) {
        video.error = messageOf(error);
      },
    });
    video.encoder.configure(config);
    return video;
  }

  // One frame onto one video: drawn over black, so a side cropped to even leaves no stale pixels.
  function encodeOn(video, bitmap, timing, keyFrame) {
    video.context.fillStyle = '#000';
    video.context.fillRect(0, 0, video.canvas.width, video.canvas.height);
    video.context.drawImage(bitmap, 0, 0);
    const frame = new VideoFrame(video.canvas, timing);
    video.encoder.encode(frame, { keyFrame });
    frame.close();
  }

  function resultOf(video, durations) {
    video.encoder.close();
    return {
      codec: video.codec,
      width: video.canvas.width,
      height: video.canvas.height,
      description: video.description && toBase64(video.description),
      frames: video.chunks.map((chunk) => ({
        data: toBase64(chunk.data),
        timestampMs: chunk.timestamp / 1000,
        durationMs: durations.get(chunk.timestamp) ?? 0,
        key: chunk.key,
      })),
    };
  }

  let session;
  globalThis.__qunitxEncoder = {
    setup(settings) {
      session = { settings, videos: null, durations: new Map(), lastKeyMs: -Infinity };
    },
    // Each frame is decoded once and drawn for every container asked for.
    async add({ png, timestampMs, durationMs }) {
      const { settings } = session;
      const bitmap = await createImageBitmap(new Blob([toBytes(png)], { type: 'image/png' }));
      session.videos ??= await Promise.all(
        settings.targets.map((target) => open(target, bitmap.width, bitmap.height, settings.fps)),
      );
      const problem =
        session.videos.find((video) => typeof video === 'string') ??
        session.videos.find((video) => video.error)?.error;
      if (problem) return problem;

      const timestamp = Math.round(timestampMs * 1000);
      const timing = { timestamp, duration: Math.max(1, Math.round(durationMs * 1000)) };
      const keyFrame = timestampMs - session.lastKeyMs >= settings.keyframeEveryMs;
      if (keyFrame) session.lastKeyMs = timestampMs;
      session.durations.set(timestamp, durationMs);
      session.videos.forEach((video) => encodeOn(video, bitmap, timing, keyFrame));
      bitmap.close();
      await drained(session.videos);
      return null;
    },
    async finish() {
      const { videos, durations } = session;
      const problem =
        (await Promise.all(videos.map((video) => video.encoder.flush())).then(() => null, messageOf)) ??
        videos.find((video) => video.error)?.error ??
        (videos.some(reordered) ? 'the encoder reordered frames, which this writer does not support' : null);
      return problem ? { error: problem } : { videos: videos.map((video) => resultOf(video, durations)) };
    },
  };
})()`;

/**
 * Video as an encoder hands it over: the frames in order with their times, ready to be written
 * into a container by {@link import('./webm.ts').mux} or {@link import('./mp4.ts').mux}.
 *
 * ```ts
 * const video: EncodedVideo = { codec: 'vp9', width: 2, height: 2, description: null, frames: [] };
 * video.codec; // 'vp9'
 * ```
 */
export interface EncodedVideo {
  /** What the frames are encoded as. */
  codec: 'h264' | 'vp8' | 'vp9' | 'av1';
  /** In pixels: H.264 frames are cropped to even sides. */
  width: number;
  /** In pixels, like `width`. */
  height: number;
  /** The decoder configuration (H.264's `avcC`), or null for codecs that carry none. */
  description: Uint8Array | null;
  /** The encoded frames, in decode order. */
  frames: { data: Uint8Array; timestampMs: number; durationMs: number; key: boolean }[];
}

type Container = 'webm' | 'mp4';

// The encoder page's global, as the Node side calls it.
interface EncoderGlobal {
  __qunitxEncoder: {
    setup(settings: {
      targets: { container: Container; candidates: string[] }[];
      fps: number;
      keyframeEveryMs: number;
    }): void;
    add(call: { png: string; timestampMs: number; durationMs: number }): Promise<string | null>;
    finish(): Promise<{ videos: EncodedInPage[] } | { error: string }>;
  };
}

// An encoded video as it leaves the page: its bytes in base64.
interface EncodedInPage {
  codec: EncodedVideo['codec'];
  width: number;
  height: number;
  description: string | null;
  frames: { data: string; timestampMs: number; durationMs: number; key: boolean }[];
}

/**
 * Writes `.webm` and `.mp4` files of every clip in turn, one per output, encoded by the browser in
 * `context`: each clip's shots kept to `fps`, each shown until the next was taken, and its last for
 * the clip's `lastFrameDurationMs`. Each frame goes to the browser and is decoded once, however
 * many outputs it ends up in.
 *
 * ```ts
 * import * as Video from './video.ts';
 * import type { Clip } from './capture.ts';
 * import type { Output } from './outputs.ts';
 * import type { BrowserContext } from 'playwright-core';
 *
 * // Defined, not invoked: needs a live browser.
 * async function film(outputs: Output[], clips: Clip[], context: BrowserContext) {
 *   return (await Video.record(outputs, clips, 10, context)).map((file) => file.frames);
 * }
 * ```
 */
export async function record(
  outputs: Outputs.Output[],
  clips: Capture.Clip[],
  fps: number,
  context: BrowserContext,
): Promise<RecordedFile[]> {
  const containerOf = (output: Outputs.Output): Container =>
    output.format === 'mp4' ? 'mp4' : 'webm';
  const containers = [...new Set(outputs.map(containerOf))];
  const videos = await encodeInBrowser(context, Capture.timeline(clips, fps), containers, fps);
  return Promise.all(
    outputs.map((output) => {
      const container = containerOf(output);
      const video = videos[containers.indexOf(container)];
      return Outputs.write(output, container === 'mp4' ? MP4.mux(video) : WebM.mux(video), {
        width: video.width,
        height: video.height,
        frames: video.frames.length,
      });
    }),
  );
}

// Encodes frames with the browser's own video encoder (WebCodecs), one video per container: VP9
// (or VP8 where VP9 is missing) for .webm, H.264 for .mp4. Every engine ships encoders, so nothing
// is installed; frames carry their own timestamps, so encoding runs as fast as the encoder goes.
async function encodeInBrowser(
  context: BrowserContext,
  frames: Capture.Frame[],
  containers: Container[],
  fps: number,
): Promise<EncodedVideo[]> {
  if (frames.length === 0) throw new Error('a video needs at least one frame');
  const page = await context.newPage();
  try {
    await page.route(ENCODER_URL, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>encoder</title>' }),
    );
    await page.goto(ENCODER_URL);
    await page.evaluate(ENCODER_SOURCE);
    await page.evaluate(
      (settings) => (globalThis as unknown as EncoderGlobal).__qunitxEncoder.setup(settings),
      {
        targets: containers.map((container) => ({ container, candidates: CANDIDATES[container] })),
        fps,
        keyframeEveryMs: KEYFRAME_EVERY_MS,
      },
    );
    let timestampMs = 0;
    for (const { png, durationMs } of frames) {
      // As base64, by hand: Playwright's own transfer of a typed array measured ~3× slower on Node 24.
      const call = {
        png: Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString('base64'),
        timestampMs,
        durationMs,
      };
      const problem = await page.evaluate(
        (call) => (globalThis as unknown as EncoderGlobal).__qunitxEncoder.add(call),
        call,
      );
      if (problem) throw new Error(problem);
      timestampMs += durationMs;
    }
    const done = await page.evaluate(() =>
      (globalThis as unknown as EncoderGlobal).__qunitxEncoder.finish(),
    );
    if ('error' in done) throw new Error(done.error);
    return done.videos.map((video) => ({
      ...video,
      description: video.description === null ? null : fromBase64(video.description),
      frames: video.frames.map((frame) => ({ ...frame, data: fromBase64(frame.data) })),
    }));
  } finally {
    await page.close().catch(() => {});
  }
}

// Plain bytes, not a Buffer: a Buffer's slice is a view, which callers do not expect.
function fromBase64(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}
