import { writeFileSync } from 'node:fs';
import { run } from './tools.ts';
import type { Recording } from './record.ts';
import type { Tool } from './tools.ts';

// Everything ffmpeg does. Two steps, and they are separate because the first is lossless and the
// second is not: each scene becomes an ffv1 .mkv of caption-over-terminal-beside-pane, and only
// once they are joined is a single palette chosen for the whole thing. Quantising per scene
// instead would make the same red shift between scenes.

/** How many frames a second the finished GIF runs at. */
export const FPS = 12;

/**
 * One scene as a lossless intermediate: the caption along the top, the terminal and the browser
 * pane side by side under it.
 *
 * Both tracks are concat-demuxer playlists rather than videos, because the terminal was recorded
 * at whatever rate it repainted and the pane changes a handful of times — writing each as "this
 * picture, for this long" lets ffmpeg resample both onto {@link FPS} without either being
 * stretched to fit the other.
 */
export function composeScene(
  ffmpeg: Tool,
  recording: Recording,
  captionFile: string,
  work: string,
  cwd: string,
): void {
  const { name, frames, panes, durationMs } = recording;
  writeFileSync(`${work}/${name}.frames.txt`, playlist(frames, durationMs));
  writeFileSync(
    `${work}/${name}.panes.txt`,
    playlist(
      panes.map(({ shot, atMs }) => ({ file: `${work}/pane-${shot}.png`, atMs })),
      durationMs,
    ),
  );
  run(
    ffmpeg,
    [
      ...['-y', '-v', 'error'],
      ...['-loop', '1', '-i', captionFile],
      ...['-f', 'concat', '-safe', '0', '-i', `${work}/${name}.frames.txt`],
      ...['-f', 'concat', '-safe', '0', '-i', `${work}/${name}.panes.txt`],
      ...[
        '-filter_complex',
        `[0:v]fps=${FPS},format=rgb24[c];[1:v]fps=${FPS},format=rgb24[t];` +
          `[2:v]fps=${FPS},format=rgb24[b];[t][b]hstack=shortest=1[m];[c][m]vstack=shortest=1`,
      ],
      ...['-t', (durationMs / 1000).toFixed(3), '-c:v', 'ffv1', `${work}/${name}.mkv`],
    ],
    cwd,
  );
}

/**
 * The scenes, end to end, as the GIF that ships.
 *
 * One palette for the whole film — generated from every frame, then applied — and no dithering,
 * because a terminal is flat colour and dithering only gives it a texture to compress. gifsicle
 * takes the last third of the file off afterwards.
 */
export function stitch(
  tools: { ffmpeg: Tool; gifsicle: Tool },
  recordings: readonly Recording[],
  work: string,
  output: string,
  cwd: string,
): void {
  writeFileSync(
    `${work}/scenes.txt`,
    recordings.map(({ name }) => `file '${work}/${name}.mkv'`).join('\n'),
  );
  run(
    tools.ffmpeg,
    [
      ...['-y', '-v', 'error'],
      ...['-f', 'concat', '-safe', '0', '-i', `${work}/scenes.txt`],
      ...[
        '-filter_complex',
        '[0:v]split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none',
      ],
      ...['-loop', '0', `${work}/demo.gif`],
    ],
    cwd,
  );
  run(tools.gifsicle, ['-O3', '--lossy=20', `${work}/demo.gif`, '-o', output], cwd);
}

/** `file … / duration …` pairs, which is what the concat demuxer reads. */
function playlist(entries: readonly { file: string; atMs: number }[], durationMs: number): string {
  return (
    entries
      .map(({ file, atMs }, i) => {
        const next = entries[i + 1]?.atMs ?? durationMs;

        return `file '${file}'\nduration ${((next - atMs) / 1000).toFixed(3)}`;
      })
      // The demuxer drops the last entry's duration unless the file is listed one more time.
      .concat(`file '${entries.at(-1)!.file}'`)
      .join('\n')
  );
}
