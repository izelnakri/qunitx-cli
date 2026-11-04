import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Buffer } from 'node:buffer';
import * as Capture from './capture.ts';
import * as GIF from './gif.ts';
import * as Video from './video.ts';
import type * as Outputs from './outputs.ts';
import type { RecordedFile } from './index.ts';
import type { BrowserContext } from 'playwright-core';

// `record --live`: frames go out as they are made, not once everything has been recorded. Each one
// is encoded into every GIF and video as soon as the next frame shows it is finished, and shown on
// a local preview page that plays the recording as it grows.

/**
 * A recording whose frames are encoded and previewed as they come, in the order they are added.
 *
 * ```ts
 * import * as Live from './live.ts';
 * import type { Clip } from './capture.ts';
 *
 * // Defined, not invoked: opened by `record` under `live`.
 * async function addPage(live: Live.Recording, clip: Clip) {
 *   await live.frames.addClip(clip);
 * }
 * ```
 */
export interface Recording {
  /** Where each input's frames go, clip by clip or (a tour's) frame by frame. */
  frames: Capture.FrameStream;
  /** Every animated output, written once its last frame is in. */
  finish(): Promise<Map<Outputs.Output, RecordedFile>>;
  /** Stops the preview page; the files are already written, or will not be. */
  close(): Promise<void>;
}

/**
 * Opens a live recording: a writer for each animated output, and the preview, whose address is
 * handed to `onPreview` once it serves. Outputs that are not animated are left to `record`.
 *
 * ```ts
 * import * as Live from './live.ts';
 * import type { Output } from './outputs.ts';
 * import type { BrowserContext } from 'playwright-core';
 *
 * // Defined, not invoked: needs a live browser.
 * async function start(outputs: Output[], context: BrowserContext) {
 *   return await Live.open(outputs, { fps: 10, context, onPreview: (url) => console.log(url) });
 * }
 * ```
 */
export async function open(
  outputs: Outputs.Output[],
  options: { fps: number; context: BrowserContext; onPreview: (previewUrl: string) => void },
): Promise<Recording> {
  const gifs = outputs
    .filter((output) => output.format === 'gif')
    .map((output) => [output, GIF.open(output)] as const);
  const videoOutputs = outputs.filter(
    (output) => output.format === 'webm' || output.format === 'mp4',
  );
  const videos = videoOutputs.length
    ? await Video.open(videoOutputs, options.fps, options.context)
    : null;
  const preview = await servePreview();
  options.onPreview(preview.url);
  const frames = new Capture.FrameStream(options.fps, async (frame) => {
    preview.show(frame);
    for (const [, gif] of gifs) await gif.add(frame);
    await videos?.add(frame);
  });
  return {
    frames,
    async finish() {
      await frames.finish();
      preview.end();
      const written = await Promise.all(gifs.map(([, gif]) => gif.finish()));
      const filmed = videos ? await videos.finish() : [];
      return new Map([
        ...gifs.map(([output], index) => [output, written[index]] as const),
        ...videoOutputs.map((output, index) => [output, filmed[index]] as const),
      ]);
    },
    close: () => preview.close(),
  };
}

// The preview: a page that plays frames as they arrive, from a server-sent event stream. Every
// frame is kept, so a page opened late, or reloaded, plays the recording from its start.
async function servePreview(): Promise<{
  url: string;
  show(frame: Capture.Frame): void;
  end(): void;
  close(): Promise<void>;
}> {
  const sent: string[] = [];
  const watchers = new Set<ServerResponse>();
  let ended = false;
  const server = createServer((request, response) => {
    if (request.url !== '/frames') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return response.end(PREVIEW_HTML);
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    for (const event of sent) response.write(event);
    if (ended) return response.end('event: end\ndata:\n\n');
    watchers.add(response);
    request.on('close', () => watchers.delete(response));
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    show({ png, durationMs }) {
      const data = JSON.stringify({ png: Buffer.from(png).toString('base64'), durationMs });
      const event = `data: ${data}\n\n`;
      sent.push(event);
      for (const watcher of watchers) watcher.write(event);
    },
    end() {
      ended = true;
      for (const watcher of watchers) watcher.end('event: end\ndata:\n\n');
      watchers.clear();
    },
    close: () =>
      new Promise((closed) => {
        for (const watcher of watchers) watcher.end();
        server.close(() => closed());
        server.closeAllConnections();
      }),
  };
}

// Plays the frames in order, each for its own duration, catching up on any that queued meanwhile.
const PREVIEW_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>qunitx record --live</title><style>
html, body { margin: 0; height: 100%; background: #1d2028; color: #e8eaed; font: 14px system-ui, sans-serif; }
body { display: grid; grid-template-rows: auto 1fr; }
header { padding: 10px 16px; display: flex; gap: 16px; align-items: center; }
#status::before { content: ""; display: inline-block; width: 8px; height: 8px; margin-right: 8px; border-radius: 50%; background: #e03131; }
#status.done::before { background: #2f9e44; }
main { display: grid; place-items: center; overflow: hidden; padding: 0 16px 16px; }
img { max-width: 100%; max-height: calc(100vh - 60px); box-shadow: 0 8px 30px rgba(0,0,0,.4); }
</style></head><body>
<header><span id="status">Recording</span><span id="count"></span></header>
<main><img id="frame" alt=""></main>
<script>
  const queue = [];
  let shown = 0;
  let playing = false;
  const status = document.getElementById('status');
  const count = document.getElementById('count');
  // Shows the next frame for its duration, then the one after; idle once the queue runs dry.
  const next = () => {
    const frame = queue.shift();
    playing = Boolean(frame);
    if (!frame) return;
    document.getElementById('frame').src = 'data:image/png;base64,' + frame.png;
    count.textContent = ++shown + ' frames';
    setTimeout(next, frame.durationMs);
  };
  const events = new EventSource('/frames');
  events.onmessage = (event) => {
    queue.push(JSON.parse(event.data));
    if (!playing) next();
  };
  events.addEventListener('end', () => {
    events.close();
    status.textContent = 'Recorded';
    status.className = 'done';
  });
</script>
</body></html>`;
