# QUnitX demo — terminal portion of the composite GIF
# Run: nix run nixpkgs#vhs -- docs/demo.tape
# Output: docs/terminal.gif  (composited into docs/demo.gif by make-demo-gif.sh)

Output docs/terminal.gif

Set Shell "zsh"
Set FontSize 14
Set Width 700
Set Height 680
Set Theme "Dracula"
Set Padding 20
Set TypingSpeed 55ms
Set PlaybackSpeed 0.85

Hide
Type "setopt interactive_comments"
Enter
Type "alias qunitx=$(pwd)/cli.js"
Enter
Sleep 200ms
# Create failing version: copy demo-math-test.js with the score bug (88 → 87)
Type "cp docs/demo-math-test.js docs/demo-math-test.failing.js && sed -i '/const response/s/88/87/' docs/demo-math-test.failing.js"
Enter
Sleep 400ms
Show

# ── 1. Show the test file ─────────────────────────────────────────────────────
Type "bat --paging=never docs/demo-math-test.js"
Enter
Sleep 4000ms

Hide
Type "clear"
Enter
Show

# ── 2. qunitx --debug: headless Chrome, TAP output, browser console ───────────
Type "# qunitx: headless Chrome, streams TAP, pipes browser console"
Enter
Sleep 400ms
Type "qunitx docs/demo-math-test.failing.js --debug"
Enter
Sleep 9500ms

Hide
Type "clear"
Enter
Show

# ── 3. --failFast: stop immediately on the first failure ──────────────────────
Type "# --failFast: stop on the first failure"
Enter
Sleep 400ms
Type "qunitx docs/demo-math-test.failing.js --failFast"
Enter
Sleep 6000ms

Hide
Type "clear"
Enter
# Background: 'fix' the file 9 seconds from now — fires during the watch run
Type "(sleep 9 && cp docs/demo-math-test.js docs/demo-math-test.failing.js) &"
Enter
Sleep 200ms
Show

# ── 4. --watch: live fail → fix → pass cycle ──────────────────────────────────
Type "# --watch: re-runs on every file save"
Enter
Sleep 400ms
Type "qunitx docs/demo-math-test.failing.js --watch"
Enter
Sleep 4500ms
# Background fires ~9s after the hidden job was queued, ~5.2s after qunitx started.
# Initial failing run is done; file is replaced; watch detects change and re-runs.
Sleep 5500ms
Ctrl+C
Sleep 800ms

Hide
Type "clear"
Enter
Show

# ── 5. node --test: same file, same results ───────────────────────────────────
Type "# Same file in Node.js — zero extra config"
Enter
Sleep 400ms
Type "node --test docs/demo-math-test.js"
Enter
Sleep 5500ms
