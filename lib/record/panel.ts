import type { Style } from './tour/compose.ts';

/**
 * A band above or below the frame for the step's title, its caption and where it is among the
 * steps. A GIF has it drawn into every frame; the HTML player has it as live HTML. Both use this
 * module's markup, stylesheet and script, so one `css` styles it the same in either.
 *
 * ```ts
 * const panel: Panel = { placement: 'below', height: 96, style: { background: '#5f3dc4' } };
 * ```
 */
export interface Panel {
  /** Above the frame (and its address bar), or below the page. */
  placement: 'above' | 'below';
  /** In CSS pixels: fixed, so every frame of a recording is the same size. */
  height: number;
  /** CSS declarations for `#panel` itself. */
  style: Style;
}

/**
 * How tall a panel is unless it says otherwise: a title, a line of caption and the step dots.
 *
 * ```ts
 * import { DEFAULT_PANEL_HEIGHT } from './panel.ts';
 *
 * DEFAULT_PANEL_HEIGHT; // 96
 * ```
 */
export const DEFAULT_PANEL_HEIGHT = 96;

/**
 * The panel's own stylesheet: the defaults a look's `css` and `panel.style` lay over. Selectors:
 * `#panel`, `#panel .title`, `#panel .caption`, `#panel .notes`, `#panel .steps`, `#panel .step`,
 * `#panel .step.active`, and in the player `#panel .controls button` (`.prev`, `.play`, `.next`).
 *
 * ```ts
 * import { PANEL_CSS } from './panel.ts';
 *
 * PANEL_CSS.includes('#panel .step.active'); // true
 * ```
 */
export const PANEL_CSS = `
#panel { display: flex; flex-direction: column; justify-content: center; gap: 6px; padding: 12px 20px; overflow: hidden;
  background: #11141c; color: #f1f3f5; font: 15px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; }
#panel .row { display: flex; align-items: center; gap: 12px; min-width: 0; }
#panel .title { flex: 1; min-width: 0; font-size: 18px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#panel .caption { opacity: .85; }
#panel .notes { opacity: .7; font-size: 13px; white-space: pre-line; }
#panel .caption:empty, #panel .notes:empty { display: none; }
#panel .steps { display: flex; flex-wrap: wrap; gap: 6px; }
#panel .step { width: 8px; height: 8px; padding: 0; border: 0; border-radius: 50%; background: rgba(255,255,255,.3); }
#panel .step.active { background: #ffd43b; }
#panel .controls { display: flex; gap: 6px; }
#panel .controls button { min-width: 34px; height: 30px; padding: 0 10px; border: 1px solid rgba(255,255,255,.25); border-radius: 6px;
  background: transparent; color: inherit; font: inherit; cursor: pointer; }
#panel .controls button:hover { background: rgba(255,255,255,.1); }
#panel button:focus-visible { outline: 2px solid #ffd43b; outline-offset: 2px; }
#panel button.step { cursor: pointer; }
`;

/**
 * The panel's markup: empty, for {@link PANEL_SCRIPT} to fill. `interactive` adds the player's
 * previous, play and next buttons; its step dots are buttons there, plain marks in a frame.
 *
 * ```ts
 * import { panelHTML } from './panel.ts';
 *
 * panelHTML(false).includes('class="title"'); // true
 * panelHTML(true).includes('class="next"'); // true
 * ```
 */
export function panelHTML(interactive: boolean): string {
  const controls = interactive
    ? '<div class="controls"><button type="button" class="prev" aria-label="Previous step">‹</button>' +
      '<button type="button" class="play" aria-label="Play">▶</button>' +
      '<button type="button" class="next" aria-label="Next step">›</button></div>'
    : '';
  return (
    `<div id="panel" role="region" aria-label="Steps"><div class="row"><div class="title"></div>${controls}</div>` +
    '<div class="caption" aria-live="polite"></div><div class="notes"></div><div class="steps"></div></div>'
  );
}

/**
 * The panel's script, run in the page that shows it. `__panelSetup(titles, interactive)` makes a
 * mark per step (a button in the player, which calls `onStep` with its index); `__panel(index,
 * caption, notes)` shows a step. Text goes in through `textContent`, so a title is never markup.
 *
 * ```ts
 * import { PANEL_SCRIPT } from './panel.ts';
 *
 * PANEL_SCRIPT.includes('__panelSetup'); // true
 * ```
 */
export const PANEL_SCRIPT = `
(() => {
  let titles = [];
  globalThis.__panelSetup = (given, interactive, onStep) => {
    titles = given;
    const steps = document.querySelector('#panel .steps');
    steps.replaceChildren(...titles.map((title, index) => {
      const mark = document.createElement(interactive ? 'button' : 'span');
      mark.className = 'step';
      mark.title = title;
      mark.setAttribute('aria-label', (index + 1) + '. ' + title);
      if (interactive) {
        mark.type = 'button';
        mark.addEventListener('click', () => onStep(index));
      }
      return mark;
    }));
  };
  globalThis.__panel = (index, caption, notes) => {
    const panel = document.getElementById('panel');
    panel.querySelector('.title').textContent = titles[index] || '';
    panel.querySelector('.caption').textContent = caption || '';
    panel.querySelector('.notes').textContent = notes || '';
    panel.querySelectorAll('.step').forEach((mark, at) => {
      mark.classList.toggle('active', at === index);
      if (at === index) mark.setAttribute('aria-current', 'step');
      else mark.removeAttribute('aria-current');
    });
  };
})();
`;

/**
 * A panel already filled in, for a page that has no script to fill it: a step of a printed
 * recording. Text is escaped; the marks are the same as {@link PANEL_SCRIPT} makes.
 *
 * ```ts
 * import { filledPanelHTML } from './panel.ts';
 *
 * filledPanelHTML(['One', 'Two'], 1, 'Pay <now>', null).includes('Pay &lt;now>'); // true
 * ```
 */
export function filledPanelHTML(
  titles: string[],
  index: number,
  caption: string | null,
  notes: string | null,
): string {
  const text = (value: string | null) =>
    (value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const marks = titles
    .map(
      (title, at) =>
        `<span class="step${at === index ? ' active' : ''}" title="${text(title)}"></span>`,
    )
    .join('');
  return (
    `<div id="panel"><div class="row"><div class="title">${text(titles[index])}</div></div>` +
    `<div class="caption">${text(caption)}</div><div class="notes">${text(notes)}</div>` +
    `<div class="steps">${marks}</div></div>`
  );
}
