# qunitx-cli demo — generates demo/demo.gif.
# Run via: make demo  (handles Chrome discovery automatically)

Output demo/demo.gif

Set Shell bash
Set FontSize 20
Set Width 560
Set Height 380
Set Theme "Dracula"
Set Padding 20

Env PUPPETEER_SKIP_DOWNLOAD "true"
Env FORCE_COLOR "1"

Sleep 500ms
Type "npx qunitx demo/example-test.js"
Sleep 500ms
Enter
Sleep 15s
