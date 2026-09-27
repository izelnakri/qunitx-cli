// How the frame is divided up: which panes there are, how big, and how they stack.
//
// Pure — it works in rectangles and ffmpeg filter labels, so `demo.ts` stays the only part that
// runs anything. A workspace nests the way a tmux window does: a pane, or a row or column of
// panes, all the way down.

export interface Dimensions {
  width: number;
  height: number;
}

/** The three things a pane can be. A terminal and a browser pane differ only in what fills them. */
export type PaneKind = 'terminal' | 'screenshots' | 'caption';

/**
 * One pane, or a split of panes.
 *
 * `row` puts its children side by side and `column` stacks them, so the demo's own frame is a
 * caption strip above a row of two:
 *
 * ```ts
 * const workspace = {
 *   column: [
 *     { caption: { height: 56 } },
 *     { row: [{ terminal: { width: 720, height: 600 } }, { screenshots: { width: 440, height: 600 } }] },
 *   ],
 * };
 * ```
 *
 * `terminal` is the shell the tape types into, `screenshots` is the pane `Pane <name>` switches,
 * and `caption` is the strip written from the tape's own words — it says only how tall it is,
 * because it spans whatever column it is stacked in.
 */
export type Workspace =
  | { row: Workspace[] }
  | { column: Workspace[] }
  | { terminal: Dimensions }
  | { screenshots: Dimensions }
  | { caption: { height: number } };

/** What a storyboard gets when it does not say: captions over a terminal and a browser pane. */
export const SIDE_BY_SIDE: Workspace = {
  column: [
    { caption: { height: 56 } },
    {
      row: [
        { terminal: { width: 720, height: 600 } },
        { screenshots: { width: 440, height: 600 } },
      ],
    },
  ],
};

/** One pane with its rectangle worked out. */
export interface MeasuredPane {
  kind: PaneKind;
  dimensions: Dimensions;
}

/** A whole workspace with every rectangle worked out, splits included. */
export type MeasuredWorkspace =
  MeasuredPane | { kind: 'row' | 'column'; dimensions: Dimensions; children: MeasuredWorkspace[] };

/**
 * Works out every rectangle in a workspace, and refuses one that cannot be stacked.
 *
 * ffmpeg can only stack pictures that line up, so the panes in a row have to be the same height
 * and the panes in a column the same width. That is checked here, by name, rather than surfacing
 * an hour later as an ffmpeg error about matching dimensions.
 *
 * ```ts
 * import { measureWorkspace } from 'demogod';
 *
 * const frame = { row: [{ terminal: { width: 8, height: 4 } }, { screenshots: { width: 2, height: 4 } }] };
 * measureWorkspace(frame).dimensions; // { width: 10, height: 4 }
 * ```
 */
export function measureWorkspace(workspace: Workspace): MeasuredWorkspace {
  return measurePane(workspace);
}

/** Every pane, left to right and top to bottom — the order ffmpeg reads its inputs in. */
export function panesOfWorkspace(measured: MeasuredWorkspace): MeasuredPane[] {
  return 'children' in measured ? measured.children.flatMap(panesOfWorkspace) : [measured];
}

/** The pane of this kind, or nothing when the workspace has none. More than one is an error. */
export function paneOfKind(measured: MeasuredWorkspace, kind: PaneKind): MeasuredPane | undefined {
  const found = panesOfWorkspace(measured).filter((pane) => pane.kind === kind);
  if (found.length > 1) throw new Error(`a workspace can only have one ${kind} pane`);

  return found[0];
}

/**
 * The ffmpeg `filter_complex` that stacks the panes into the finished frame.
 *
 * Every pane is one input, in {@link panesOfWorkspace} order, and each is resampled onto `fps`
 * before it is stacked: the terminal was recorded at whatever rate it repainted and a pane of
 * stills changes a handful of times, so neither can be stretched to fit the other.
 */
export function stackFilter(measured: MeasuredWorkspace, fps: number): string {
  const chains: string[] = [];
  let panes = 0;
  let splits = 0;
  const label = (node: MeasuredWorkspace): string => {
    if (!('children' in node)) {
      const pane = `p${panes}`;
      chains.push(`[${panes++}:v]fps=${fps},format=rgb24[${pane}]`);

      return pane;
    }

    const inputs = node.children.map(label);
    const split = `s${splits++}`;
    const stack = node.kind === 'row' ? 'hstack' : 'vstack';
    const from = inputs.map((input) => `[${input}]`).join('');
    chains.push(`${from}${stack}=inputs=${inputs.length}:shortest=1[${split}]`);

    return split;
  };
  const frame = label(measured);
  // The last chain is the frame itself, and ffmpeg maps whatever is left unlabelled.
  chains.push(chains.pop()!.replace(`[${frame}]`, ''));

  return chains.join(';');
}

function measurePane(node: Workspace, spans?: Partial<Dimensions>): MeasuredWorkspace {
  if ('terminal' in node) {
    return { kind: 'terminal', dimensions: node.terminal };
  } else if ('screenshots' in node) {
    return { kind: 'screenshots', dimensions: node.screenshots };
  } else if ('caption' in node) {
    if (spans?.width === undefined) {
      throw new Error('a caption spans a column, so it has to be stacked in one');
    }

    return { kind: 'caption', dimensions: { width: spans.width, height: node.caption.height } };
  }

  return measureSplit('row' in node ? 'row' : 'column', 'row' in node ? node.row : node.column);
}

/** A row adds up its children's widths and shares their height; a column, the other way round. */
function measureSplit(kind: 'row' | 'column', children: Workspace[]): MeasuredWorkspace {
  const shared = kind === 'row' ? 'height' : 'width';
  const added = kind === 'row' ? 'width' : 'height';
  // A caption is measured second, because what it spans is whatever the others turn out to be.
  const sized = children.map((child) => ('caption' in child ? null : measurePane(child)));
  const agreed = [...new Set(sized.flatMap((pane) => (pane ? [pane.dimensions[shared]] : [])))];
  if (agreed.length !== 1) {
    throw new Error(
      `the panes in a ${kind} need one ${shared} between them, not ${agreed.join(' and ') || 'none'}`,
    );
  }

  const measured = children.map(
    (child, index) => sized[index] ?? measurePane(child, { [shared]: agreed[0] }),
  );

  const span = agreed[0]!;
  const sum = measured.reduce((total, pane) => total + pane.dimensions[added], 0);

  return {
    kind,
    children: measured,
    dimensions: kind === 'row' ? { width: sum, height: span } : { width: span, height: sum },
  };
}
