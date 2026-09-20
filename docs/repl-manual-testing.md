# Testing `qunitx repl` by hand

Everything `qunitx repl` does, in the order it makes sense to try it, with the answer you should
get. Written for reviewing [#82](https://github.com/izelnakri/qunitx-cli/pull/82), and kept because
most of this is behaviour no test can prove to a person — colour, a ghost suggestion, an editor
taking the terminal, a browser window opening.

Every transcript below was captured from a real session rather than written from memory; the exact
line numbers and separators are what the commands actually print.

**Time:** about 20 minutes for all of it, 5 for §1–§4 if you only want to know it works.

**You need:** a Chromium-family browser, a terminal that is a real TTY, and `$EDITOR` set for §9.
Sections marked **TTY** switch themselves off when stdin is a pipe — that is deliberate, not a bug.

Two fixtures are used throughout, both already in the repo:

| file                             | what it has                                                         |
| -------------------------------- | ------------------------------------------------------------------- |
| `test/fixtures/repl-helpers.ts`  | `GREETING`, `double()` (with a doc comment), `boom()`, and one test |
| `test/fixtures/repl-stepping.ts` | `outer()` → `helper()`, with a `debugger` in `outer`                |

---

## 1. It starts, and evaluation happens in the page

```
node cli.ts repl
```

```
# qunitx repl — evaluating in Chrome at http://localhost:1234
# inspect the same page at http://localhost:1234/repl — or `.devtools`
# type `.help` for commands, `:<cmd>` for a shell, `.exit` or Ctrl-D to quit
```

| input                                                                                     | expected                                                                         |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `1 + 1`                                                                                   | `2`                                                                              |
| `document.title`                                                                          | `'qunitx repl'` — **a real DOM**, not Node                                       |
| `typeof window`                                                                           | `'object'`                                                                       |
| `document.body.append(Object.assign(document.createElement('p'), { textContent: 'hi' }))` | `undefined`, then `document.body.innerHTML` shows the `<p>`                      |
| `(await fetch('/tests.js')).status`                                                       | `200` — top-level `await`, against the session's own server                      |
| `let answer = 1` then `let answer = 2`                                                    | both `undefined`, no error — redeclaration works, which plain `eval` will not do |
| `Promise.resolve(5)`                                                                      | `Promise { <fulfilled> 5 }`, **not** `5` — `await` is how you unwrap             |
| `nosuchname`                                                                              | an error naming it, and the session carries on                                   |

**The point:** every one of those is the browser's, not Node's.

## 2. Tests run as you type

```
test('adds', (assert) => assert.equal(1 + 1, 2))
test('again', (assert) => assert.true(true))
module('Cart', () => { test('inside', (assert) => assert.true(true)) })
test('fails', (assert) => assert.equal(1, 2))
```

```
ok 1 adds # (2 ms)
ok 2 again # (1 ms)
ok 3 Cart | inside # (0 ms)
not ok 4 fails # (1 ms)
```

**This is the one to check.** QUnit is built to run once per page load; a session that only ran the
first test would look identical except for the missing lines. Nothing errors — the tests just
quietly would not run. (Why: `lib/setup/qunit-harness.ts`, and see §16.)

A failing test reports as a failure, not a crash — the prompt stays usable.

## 3. Preloading files

```
node cli.ts repl test/fixtures/repl-helpers.ts
```

```
# loaded test/fixtures/repl-helpers.ts: ReplHelpers, GREETING, boom, double
ok 1 preloaded test # (2 ms)
```

| input         | expected                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------- |
| `double(21)`  | `42` — exports are globals                                                                  |
| `GREETING`    | `'hello from the preload'`                                                                  |
| `ReplHelpers` | the whole namespace, one entry per line — the file under an Elixir-style name from its path |
| `boom()`      | see below                                                                                   |

```
> boom()
Uncaught Error: fixture boom
    at boom (test/fixtures/repl-helpers.ts:20:9)
    at <anonymous>:1:1
```

That the frame says `repl-helpers.ts:20:9` and not a bundle offset is source-map resolution
working. A number in the thousands means it regressed.

**Two preloads that want the same name.** `node cli.ts repl lib/task/*` loads `index.ts` (named
for the directory holding it) and `task.ts` (named for itself) — both want `Task`. The index wins,
because an index is the door into a directory, and the banner says what happened:

```
# Task is lib/task/index.ts — lib/task/task.ts also wanted it
```

To override it, quote the pattern and name the file after it:

```
node cli.ts repl 'lib/task/*' lib/task/task.ts     # Task is task.ts
```

The quoting matters and is the one rough edge: unquoted, your shell expands `lib/task/*` before
qunitx sees it, so both arrive as ordinary paths with nothing to say which was a pattern — and the
index wins. Naming the file _before_ the glob does not override either, since the pattern came
after it.

## 4. TypeScript at the prompt

```
const port: number = 1234
interface Shape { a: number }
const shape = { a: 1 } as Shape
shape.a
```

`undefined`, `undefined`, `undefined`, `1`. Types are stripped only when the engine cannot parse
the line, so plain JavaScript never pays for it.

Unfinished input still waits — `const held = { a: 1 as` should give a continuation prompt (`|`),
not an error. Finish it with `Shape }`.

## 5. Bringing files in after the fact

| input                                                            | expected                                                                                                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.load lib/repl/inspect.ts` (or `.import`)                       | `Inspect, and inspect`                                                                                                                                       |
| `import { double } from './test/fixtures/repl-helpers.ts'`       | `double` — a real `import` statement at a prompt                                                                                                             |
| `import ReplHelpers as * from './test/fixtures/repl-helpers.ts'` | ``did you mean `import * as ReplHelpers from './test/fixtures/repl-helpers.ts'`?`` — advice, not the engine's `Cannot use import statement outside a module` |
| `.import package.json`                                           | `Package` — JSON, parsed                                                                                                                                     |
| `.import README.md Readme` then `typeof Readme`                  | `Readme`, then `'string'`                                                                                                                                    |
| `.imported`                                                      | one line per file, coloured by kind:                                                                                                                         |

```
lib/repl/inspect.ts: Inspect, inspect
test/fixtures/repl-helpers.ts: double
package.json: Package
README.md: Readme
```

## 6. Asking about a value

With `repl-helpers.ts` preloaded, `.doc double` prints where it is, what was written above it,
then the thing itself — the doc comment's fenced block painted as code:

````text
> .doc double
test/fixtures/repl-helpers.ts:15
Doubles a number, and carries an example so `.doc` has a fenced block to paint as code.

```ts
const answer = double(21); // 42
```

export function double(value: number): number
````

| input                      | expected                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| `.view double`             | the same, but the **whole body** in place of the signature                                         |
| `.type double`             | `export function double(value: number): number` — the type somebody **wrote**                      |
| `.type 42`                 | `number`                                                                                           |
| `.type ({ a: 1, b: 'x' })` | `{ a: number; b: string }` — structural, worked out from the value                                 |
| `.doc GREETING`            | `test/fixtures/repl-helpers.ts` then `'hello from the preload'` — where it came in, and what it is |
| `.copy double`             | `copied N line(s)`; paste somewhere to confirm                                                     |
| `.doc` (bare)              | `Usage: .doc <value>`                                                                              |
| `.doc nosuchname`          | `nothing known about nosuchname — no such name in this session`                                    |
| `.search preloaded`        | `test/fixtures/repl-helpers.ts:23  preloaded test`                                                 |

`.doc` also answers to `.d` and `.explain`. `.h` and `.help` are one command: bare, both list every command with aliases folded onto the line
they are an alias of (`.backtrace  … [aliases .bt, .where]`) and end with
`Name anything after it for what that is`; with an argument, both are `.doc`.

## 7. Files and directories

| input                        | expected                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `.cat package.json`          | numbered, right-aligned gutter, syntax-highlighted                                  |
| `.cat README.md`             | numbered but **not** highlighted — prose through a JS tokenizer is worse than plain |
| `.cat lib/task/task.ts`      | prints — a file mentioning `constructor` used to crash this, in a TTY only          |
| `.tree -L 1 lib/repl`        | a tree, then `0 directories, 12 files`                                              |
| `.ls -L 1 lib`               | the same command                                                                    |
| `.view lib/repl`             | the tree — `.view` delegates to `.tree`                                             |
| `.view package.json`         | the file — `.view` delegates to `.cat`                                              |
| `.cat lib`                   | `lib is a directory`                                                                |
| `.cat lib/nowhere.ts`        | `no such file: lib/nowhere.ts — lib/ exists`                                        |
| `.pwd` / `.url` / `.version` | the directory / the server URL / `0.35.1`                                           |

**TTY only:** after that failed `.cat`, look at the prompt — it has been refilled with `.cat lib/`
so the next attempt costs a few keystrokes, not the whole path. And `.cat lib/re` then TAB
completes to `lib/repl/`.

## 8. A shell, without leaving

```

:git status
:ls --color=always

```

Output streams as it arrives **and keeps its colour** — the child gets the session's own terminal,
not a pipe. Try something long (`:npm ls`) and confirm it prints as it goes rather than all at the
end. A command that does not exist reports and the session survives:

```

> :nosuchcommand
> /bin/sh: line 1: nosuchcommand: command not found
> exit 127

```

## 9. The editor — **TTY**

Needs `$EDITOR`. With `repl-helpers.ts` preloaded:

| input                                 | expected                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `.open`                               | a scratch buffer. Type `1 + 1`, `:wq` → `run 1 line from the scratchpad? [Y/n]`, then `2` |
| `.open` again                         | the buffer still holds what you wrote — it lives for the session                          |
| `.open`, edit, `:q` (no save)         | **nothing runs**, and you are not asked                                                   |
| answer the prompt with `n`            | **nothing runs** — the buffer is kept for the next `.e`                                   |
| `.e` again, save without editing      | **it asks again** — a `:w` is a save even when nothing moved                              |
| `.open double`, edit, `:wq`           | `run N lines from qunitx-cli/test/fixtures/repl-helpers.ts? [Y/n]`                        |
| `.open`, write, then `:cq`            | **nothing runs**, and you are not asked ¹                                                 |
| `.open` again after that, save `:wq`  | it runs — an abandoned buffer does not poison the next one                                |
| a buffer ending `let me =`            | `Uncaught SyntaxError: Unexpected end of input`, and nothing in it runs                   |
| `.open double`                        | opens `repl-helpers.ts` at `double`'s line                                                |
| `.open https://example.com`           | opens your browser — `xdg-open`'s bargain                                                 |
| `.e`, `.edit`, `.vi`, `.vim`, `.nvim` | the same command                                                                          |

**Save-and-reload:** with the file open, change `double` to `value * 3`, save and quit. The session
reloads the file and says what came back; then `double(21)` → `63`. A file the session has and the
file on disk are the same file.

¹ `:wq`, `:x`, `ZZ`, and `:w` followed by `:q` or `:q!` all leave a byte-identical file, all exit
0, and differ by about four milliseconds between the write and the exit — measured. There is
nothing there to infer an intention from, which is why the prompt asks rather than guesses. Enter
or anything starting with `y` runs it; everything else, including a mistyped command, does not.
`:cq` exits non-zero and is not asked about at all.

What triggers the question is a WRITE, read off the file's mtime — not whether the text came back
different. Saving the same bytes twice asks twice, which is the whole point: declining and
reopening used to leave you with a buffer that could never be offered again.

_(Known wart: from outside the editor, `:w` then `:q` cannot be told from `:wq` — all the process
sees is an exit code and a changed file, so both run. Documented in `editor.ts`.)_

## 10. The debugger

```

node cli.ts repl test/fixtures/repl-stepping.ts

```

```

> outer()
> paused at outer (test/fixtures/repl-stepping.ts:11:3) — `.locals` for scope, `.continue` to carry on
> 9 │ export function outer(): number {
> 10 │ const start = 21;
> 11 │ debugger;
> 12 │ const answer = helper(start);
> 13 │
> 14 │ return answer;

```

| input                          | expected                                                    |
| ------------------------------ | ----------------------------------------------------------- |
| `start2`                       | `21` — evaluating **in the paused frame** ¹                 |
| `.locals`                      | `start2  21` — what the stopped frame can see               |
| `.scope`                       | a different list: what the session added to the page        |
| `.step`                        | into the next line, `outer (…:12:18)`, with a fresh excerpt |
| `.next` / `.finish`            | over the next call / out to the caller                      |
| `.backtrace` (`.bt`, `.where`) | `> #0  outer (…:12:18)` then `  #1  <anonymous>:1`          |
| `.up` / `.down` / `.back`      | move which frame you read; `.up -1` is `.down 1`, as in gdb |
| `.frame 1` / `.here`           | a frame by number / where you are, without moving           |
| `.up zz`                       | `Usage: .up [count]`                                        |
| `let scoped = 1` at the pause  | gone after `.continue`; `var` and `function` survive        |
| `.continue` (`.c`, `.resume`)  | the call returns `42`                                       |

¹ `start` reports as `start2` because esbuild renamed the local around QUnit's global `start`. That
is its true name in the page; a nicer lie would be a worse debugger.

**`.break` has two jobs.** Bare, it abandons an unfinished line — type `const half = {`, then
`.break`, then `1 + 1`, and you get `2` rather than a syntax error about the half-written object.
With a location, it sets a breakpoint:

```

> .break test/fixtures/repl-stepping.ts:5
> breakpoint 1 at test/fixtures/repl-stepping.ts:6

```

Note it moved to **line 6** — a breakpoint lands on the nearest runnable line at or after the one
you asked for. Then `helper(10)` pauses at `helper (…:6:10)`, `.breakpoints` lists
`1  test/fixtures/repl-stepping.ts:6`, `.delete 1` removes it, and `.breakpoints` says
`No breakpoints`.

## 11. DevTools on the same page

With a session running, open `http://localhost:1234/repl` in any Chromium browser, or type
`.devtools`.

This is **the page you are typing into**, not a copy:

- declare `const marker = 42` at the prompt → `marker` is in that console
- Elements shows the DOM your tests built
- hit a `debugger` → the terminal and DevTools show it paused together

Now open `http://localhost:1234/` (no `/repl`) in another tab and confirm `marker` is **not**
there. That is a fresh document and a second realm — the distinction is the whole reason the
address exists.

## 12. A window you can see

```

node cli.ts repl --open

```

A real Chrome window opens and the prompt drives it —
`document.body.style.background = 'tomato'` should change what you see.

On **macOS** this refuses by name — `--open cannot open a window on macOS — evaluating headlessly
instead` — and the banner offers no `/repl` address, because there is no HTTP debugging endpoint to
serve one from. `.devtools` there says `press F12 in the window instead`.

## 13. What the terminal does while you type — **TTY**

- **Syntax highlighting** — type `const a = 'x'` and watch `const` and the string colour as you go
- **Ghost suggestion** — type `docu` and a greyed-out completion appears; **Ctrl-F** takes it
- **Right-margin preview** — type `1 + 1` and pause; `2` appears against the right edge before you
  press Enter. It never runs anything with a side effect, so a call that would change something
  previews nothing
- **TAB** completes names from the page (`document.b` → `body`, …) and paths on a path line
- **Ctrl-K / Ctrl-J** walk history — the vim-shaped ones, not the arrows
- **Ctrl-C** aborts the current expression; **Ctrl-D** exits
- `.clear` clears the screen and **keeps the scrollback** — scroll up afterwards and your session
  is still there
- `.history` shows what you entered (readline's own record, so it needs the TTY)

`.save out.ts` works anywhere and writes the session out **minus the `:` shell lines** — a session
of `1+1` and `:echo hi` saves one line, not two.

## 14. Theming and colour

```

QUNITX_REPL_THEME='@string=fg=green @keyword=fg=magenta,bold' node cli.ts repl

```

Strings go green, keywords magenta-bold. The names are nvim's treesitter captures, so a theme can
be transcribed from an nvim config unchanged, and a capture inherits its parent
(`@keyword.return` from `@keyword`).

| variable               | does                                                                           |
| ---------------------- | ------------------------------------------------------------------------------ |
| `QUNITX_REPL_THEME`    | the palette above                                                              |
| `QUNITX_SUGGEST_STYLE` | the ghost suggestion's colour (`ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE` honoured too) |
| `QUNITX_REPL_CONTEXT`  | lines of source around a pause — `10`, or `10,2`, or `0` for none              |
| `QUNITX_REPL_HISTORY`  | where history is kept; empty disables it                                       |
| `NO_COLOR=1`           | no escapes anywhere                                                            |

Check the pipe path too — `printf '1+1\n' | node cli.ts repl` must emit **plain text with no escape
sequences**, so a scripted session is comparable output. `FORCE_COLOR=1` proves the opposite.

## 15. Reload, and ending

```

> let temporary = 1
> undefined
> .reload
> ok 2 preloaded test # (2 ms)
> Reloaded
> typeof temporary
> 'undefined'

```

The modules come back — the preloaded test runs again — and what you typed does not. That is the
intended trade: `let temporary = 1` is not code on disk, and bringing it back would make `.reload`
mean "reload, except keep my mistakes".

|                                     | expected                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `.exit` or Ctrl-D                   | exits 0                                                                        |
| kill the browser window mid-session | _the page is gone …_ and the process ends rather than sitting at a dead prompt |
| `node cli.ts repl no-such-file.ts`  | exits 1, names the file, **on stderr**                                         |
| `node cli.ts repl --browser=webkit` | exits 1: CDP is Chromium-only, refused by name                                 |

## 16. If something looks wrong

| symptom                               | likely cause                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| no colour anywhere                    | you are piping — colour is off without a TTY on purpose. `FORCE_COLOR=1` to check |
| no ghost suggestion or preview        | same reason; both need a TTY                                                      |
| `.devtools` says there is no endpoint | macOS, or a headed session — use F12                                              |
| a stack shows bundle offsets          | source-map resolution regressed; worth a bug                                      |
| a second `test(…)` prints nothing     | the QUnit re-arm in `lib/setup/qunit-harness.ts` broke                            |

That last one is the dangerous one, because it is silent by design — QUnit logs
`Unexpected test after runEnd` and ignores the test. It is why §2 asks for three tests rather than
one.

```

```
