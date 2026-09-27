# demogod

A GIF of a terminal, from a tape.

You write a `.tape` — captions, keys, waits, pane switches — and a storyboard saying what the names
in it mean. demogod types the tape into a real terminal, records it, and stacks the panes into a
GIF. `docs/demo.gif` in this repository is made this way; `scripts/make-demo-gif.ts` is the whole
API filled in.

```ts
import { Demo } from 'demogod';

await using demo = await Demo.open({
  tape: 'demo.tape',
  gif: 'demo.gif',
  cwd: 'example-project',
  panes: { screenshot: myScreenshotRecipe },
});

await demo.capturePanes();
await demo.recordScenes();
await demo.saveGif();
```

## The tape

The commands are [VHS](https://github.com/charmbracelet/vhs)'s wherever VHS has one — `Type`,
`Enter`, `Sleep`, `Wait`, `Ctrl+C` — so a tape reads the same here as it does anywhere else. Three
are demogod's, because VHS records one terminal and nothing else:

| Command | What it does |
| --- | --- |
| `Caption "<title>" "<detail>"` | starts a scene and writes the strip along the top |
| `Pane <name>` | switches the browser pane from here on |
| `Do <name>` | runs something off camera, between two keystrokes |

`Pane` and `Do` names are the storyboard's, not the tape's: a tape that switches to a pane nothing
takes is refused by name before anything is recorded.

## The clock

A recording of real commands takes as long as the commands took, which is different on every
machine — the same tape came out 64s on an idle box and 84s at twice the load. So the pictures come
from the recording and the timing comes from the tape: a `Type` shows for its length, a `Sleep` for
its duration, and a `Wait` for a fixed beat however long it actually blocked. Two runs of the same
tape are the same length of GIF.

## The workspace

The layout nests the way a tmux window does — a pane, or a row or column of panes:

```ts
const workspace = {
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
```

A `terminal` is the shell the tape types into, `screenshots` is the pane `Pane <name>` switches, and
a `caption` says only how tall it is because it spans the column it is stacked in. Leave the
workspace out and you get that one. Panes in a row need one height between them and panes in a
column one width, which is checked when the demo opens rather than surfacing as an ffmpeg error an
hour into a recording.

## Needs

`ttyd`, `ffmpeg` and `gifsicle` on `PATH`, and a Chrome — `chromePath`, or the one Playwright
downloads. `findProgram` will build a missing one from nixpkgs if `nix` is there.

## Status

An MVP, living in this repository so its API gets used in anger before it moves out into a package
of its own. Three files, readable in this order:

- `tape.ts` — the language, and the clock. Pure.
- `workspace.ts` — the layout. Pure.
- `demo.ts` — the machine: ttyd, a browser, ffmpeg, gifsicle.
