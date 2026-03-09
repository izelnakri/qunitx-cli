# qunitx-cli demo — generates demo/demo.gif
# Run via: make demo  (handles Chrome discovery automatically)

Output demo/demo.gif

Set Shell bash
Set FontSize 15
Set Width 800
Set Height 750
Set Theme "Dracula"
Set Padding 20
Set Framerate 24
Set TypingSpeed 45ms

Env PUPPETEER_SKIP_DOWNLOAD "true"
Env FORCE_COLOR "1"
Env PS1 "$ "

# ── 1. Show the test file ─────────────────────────────────────────────────────
Type "# 1/5  Inspect the test file"
Enter
Sleep 400ms
Type "cat demo/example-test.js"
Enter
Sleep 3000ms

# ── 2. Run all tests — concurrent by default, all green ──────────────────────
Type "# 2/5  Run tests — concurrent by default"
Enter
Sleep 400ms
Type "qunitx demo/example-test.js"
Enter
Sleep 7000ms

# ── 3. --debug: pipe Chrome's console.log to your terminal ───────────────────
Type "# 3/5  --debug: pipe Chrome console to your terminal"
Enter
Sleep 400ms
Type "qunitx demo/example-test.js --debug"
Enter
Sleep 7000ms

# ── 4. --failFast: stop immediately on the first failure ─────────────────────
Type "# 4/5  --failFast: stop on the first failure"
Enter
Sleep 400ms
Type "qunitx demo/failing-test.js --failFast"
Enter
Sleep 7000ms

# ── 5. --watch: stay alive and re-run on every file save ─────────────────────
Type "# 5/5  --watch: re-run on every file save"
Enter
Sleep 400ms
Type "qunitx demo/example-test.js --watch"
Enter
Sleep 6000ms
Ctrl+C
Sleep 1200ms
