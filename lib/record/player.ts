import { createHash } from 'node:crypto';
import { PANEL_CSS, PANEL_SCRIPT, panelHTML, type Panel } from './panel.ts';
import type { Style } from './tour/compose.ts';

/**
 * How the HTML player plays a recording.
 *
 * ```ts
 * const player: PlayerSettings = { advance: 'click', loop: false, autoplay: true, assets: 'inline' };
 * ```
 */
export interface PlayerSettings {
  /** `click`: each step plays, then waits for the viewer. `auto`: one step runs into the next. */
  advance: 'auto' | 'click';
  /** Start again from the first step after the last. */
  loop: boolean;
  /** Start playing as soon as the page opens, rather than on the first step's first frame. */
  autoplay: boolean;
  /** `inline`: one file, every picture in it. `files`: the pictures beside it, in a folder. */
  assets: 'inline' | 'files';
}

/**
 * The player's defaults.
 *
 * ```ts
 * import { DEFAULT_PLAYER } from './player.ts';
 *
 * DEFAULT_PLAYER.advance; // 'click'
 * ```
 */
export const DEFAULT_PLAYER: PlayerSettings = {
  advance: 'click',
  loop: false,
  autoplay: true,
  assets: 'inline',
};

/**
 * One frame for the player: its picture (jpeg), how long it shows, its step, and the caption to
 * show in the panel, if it has one there.
 *
 * ```ts
 * const frame: PlayerFrame = { image: new Uint8Array(0), durationMs: 100, step: 0, caption: null };
 * ```
 */
export interface PlayerFrame {
  /** A JPEG. */
  image: Uint8Array;
  /** How long it shows. */
  durationMs: number;
  /** Its step. */
  step: number;
  /** The caption the panel shows with it, or null. */
  caption: string | null;
}

/**
 * A recording as an interactive page: the frames play, and the viewer steps through them by the
 * panel's buttons and dots, the keyboard (→ / Space / Enter / PageDown, ← / PageUp, Home, End,
 * K to play or pause) or a click on the picture. The page's hash names the step (`#3`), so a link
 * can open at one. With reduced motion asked for, each step shows its last frame, unanimated.
 *
 * Identical pictures are kept once. With `assets: 'files'` they are returned as `files`, for the
 * caller to write under `assetsDir`, beside the page; otherwise they are inlined.
 *
 * ```ts
 * import { renderPlayer, DEFAULT_PLAYER } from './player.ts';
 *
 * const { html, files } = renderPlayer({
 *   title: 'Checkout',
 *   size: { width: 640, height: 360 },
 *   steps: [{ title: 'Pay', notes: null }],
 *   frames: [{ image: new Uint8Array([255, 216, 255]), durationMs: 500, step: 0, caption: null }],
 *   panel: { placement: 'below', height: 96, style: {} },
 *   css: '',
 *   player: DEFAULT_PLAYER,
 *   assetsDir: 'checkout-files',
 * });
 * html.includes('<title>Checkout</title>'); // true
 * files.length; // 0 — inlined
 * ```
 */
export function renderPlayer(options: {
  title: string;
  /** The pictures' size in CSS pixels; the player scales them down to fit, never up. */
  size: { width: number; height: number };
  steps: { title: string; notes: string | null }[];
  frames: PlayerFrame[];
  panel: Panel;
  css: string;
  player: PlayerSettings;
  assetsDir: string;
}): { html: string; files: { name: string; bytes: Uint8Array }[] } {
  const { size, panel, player } = options;
  const images: string[] = [];
  const files: { name: string; bytes: Uint8Array }[] = [];
  const indexOf = new Map<string, number>();
  const frames = options.frames.map((frame) => {
    const key = createHash('sha1').update(frame.image).digest('hex');
    if (!indexOf.has(key)) {
      indexOf.set(key, images.length);
      if (player.assets === 'files') {
        const name = `frame-${String(images.length + 1).padStart(4, '0')}.jpg`;
        files.push({ name, bytes: frame.image });
        images.push(`${encodeURI(options.assetsDir)}/${name}`);
      } else {
        images.push(`data:image/jpeg;base64,${Buffer.from(frame.image).toString('base64')}`);
      }
    }
    return {
      i: indexOf.get(key)!,
      d: Math.round(frame.durationMs),
      s: frame.step,
      c: frame.caption,
    };
  });
  const data = { images, frames, steps: options.steps, player };
  const above = panel.placement === 'above';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(options.title)}</title>
<style>
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: #e8ebf0; }
#player { width: min(100%, ${size.width}px); margin: 24px auto; display: flex; flex-direction: column; box-shadow: 0 10px 30px rgba(0,0,0,.18); border-radius: 10px; overflow: hidden; }
#viewport { position: relative; background: #000; }
#frame { display: block; width: 100%; height: auto; aspect-ratio: ${size.width} / ${size.height}; cursor: pointer; }
#panel { min-height: ${panel.height}px; }
@media (max-width: ${size.width}px) { #player { margin: 0; border-radius: 0; box-shadow: none; } }
${PANEL_CSS}
</style>
<style>${options.css.replace(/<\/style/gi, '<\\/style')}</style>
</head><body>
<main id="player" data-step="0" data-frame="0" data-playing="false">
${above ? playerPanel(panel.style) : ''}<div id="viewport"><img id="frame" alt="" width="${size.width}" height="${size.height}"></div>${above ? '' : playerPanel(panel.style)}
</main>
<script type="application/json" id="recording">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
<script>${PANEL_SCRIPT}</script>
<script>${PLAYER_SCRIPT}</script>
</body></html>
`;
  return { html, files };
}

function playerPanel(style: Style): string {
  const inline = Object.entries(style)
    .map(([property, value]) => `${property}: ${value}`)
    .join('; ');
  return panelHTML(true).replace(
    '<div id="panel"',
    `<div id="panel" style="${escapeText(inline)}"`,
  );
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

// The player itself, in the page. Every step's first and last frame are known up front, so moving
// between steps is an index, and timing is one timeout per frame, its own duration.
const PLAYER_SCRIPT = `
(() => {
  const { images, frames, steps, player } = JSON.parse(document.getElementById('recording').textContent);
  const root = document.getElementById('player');
  const picture = document.getElementById('frame');
  const playButton = root.querySelector('.play');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const first = steps.map((_, step) => frames.findIndex((frame) => frame.s === step));
  const last = steps.map((_, step) => frames.findLastIndex((frame) => frame.s === step));
  // Decoded up front, so no frame flickers in as it loads.
  images.forEach((source) => { const image = new Image(); image.src = source; });
  let at = 0;
  let playing = false;
  let timer = null;

  const stepOf = () => frames[at].s;
  const show = (index) => {
    at = index;
    const frame = frames[at];
    picture.src = images[frame.i];
    picture.alt = steps[frame.s].title;
    globalThis.__panel(frame.s, frame.c, steps[frame.s].notes);
    root.dataset.step = String(frame.s);
    root.dataset.frame = String(at);
    const hash = '#' + (frame.s + 1);
    // Embedded in a sandboxed frame the URL may not be writable: the player plays on without it.
    try {
      if (location.hash !== hash) history.replaceState(null, '', hash);
    } catch {}
  };
  const setPlaying = (value) => {
    playing = value;
    root.dataset.playing = String(value);
    playButton.textContent = value ? '❚❚' : '▶';
    playButton.setAttribute('aria-label', value ? 'Pause' : 'Play');
    clearTimeout(timer);
    if (value) timer = setTimeout(tick, frames[at].d);
  };
  const tick = () => {
    const next = at + 1;
    if (next >= frames.length) {
      if (player.loop) goTo(0);
      else setPlaying(false);
    } else if (player.advance === 'click' && frames[next].s !== stepOf()) {
      setPlaying(false); // the end of a step: the viewer moves on
    } else {
      show(next);
      setPlaying(true);
    }
  };
  // A step from its start, playing; with reduced motion, its end, still.
  const goTo = (step) => {
    const target = Math.max(0, Math.min(steps.length - 1, step));
    if (reduced) {
      show(last[target]);
      setPlaying(false);
    } else {
      show(first[target]);
      setPlaying(at < last[target] || player.advance === 'auto');
    }
  };
  // Forward: finish the step that is still playing, else on to the next.
  const next = () => {
    const step = stepOf();
    if (player.advance === 'click' && playing && at < last[step]) {
      show(last[step]);
      setPlaying(false);
    } else if (step < steps.length - 1) {
      goTo(step + 1);
    } else if (player.loop) {
      goTo(0);
    }
  };
  const previous = () => goTo(stepOf() - 1);
  const toggle = () => {
    if (playing) return setPlaying(false);
    if (at === frames.length - 1) return goTo(0);
    if (player.advance === 'click' && at === last[stepOf()]) return goTo(stepOf() + 1);
    setPlaying(true);
  };

  globalThis.__panelSetup(steps.map((step) => step.title), true, goTo);
  root.querySelector('.prev').addEventListener('click', previous);
  root.querySelector('.next').addEventListener('click', next);
  playButton.addEventListener('click', toggle);
  picture.addEventListener('click', next);
  document.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    // A focused button already acts on Space and Enter.
    if ((event.key === ' ' || event.key === 'Enter') && event.target.closest('button')) return;
    const action = {
      ArrowRight: next, PageDown: next, ' ': next, Enter: next,
      ArrowLeft: previous, PageUp: previous,
      Home: () => goTo(0), End: () => goTo(steps.length - 1),
      k: toggle, K: toggle,
    }[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  });
  addEventListener('hashchange', () => {
    const step = Number(location.hash.slice(1)) - 1;
    if (Number.isInteger(step) && step !== stepOf()) goTo(step);
  });

  const asked = Number(location.hash.slice(1)) - 1;
  const start = Number.isInteger(asked) && asked >= 0 && asked < steps.length ? asked : 0;
  show(reduced ? last[start] : first[start]);
  setPlaying(player.autoplay && !reduced);
})();
`;
