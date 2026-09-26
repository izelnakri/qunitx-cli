# docs/demo.gif, as a tape.
#
#   make demo          (or: node docs/demo/make-gif.ts)
#
# Every scene is a caption strip over a terminal beside a browser pane. The commands below are
# VHS's, so a tape reads the same here as it does anywhere else — `Type`, `Enter`, `Sleep`,
# `Wait`, `Ctrl+C`. Three are ours, because VHS has no idea a second pane exists:
#
#   Caption "<title>" "<detail>"   starts a scene and writes the strip along the top
#   Pane <name>                    switches the browser pane from here on
#   Fix                            off camera, saves the corrected test file
#
# `Wait /re/` blocks until the terminal shows that, which is what keeps the pane in step with the
# output rather than with a guessed offset. A pane name is a shot in capture-browser.ts, and that
# file says which ones need the bug on disk — nothing here has to know.
#
# To add a scene: write another `Caption`, then the keys. To add a pane: add a shot over there and
# name it here.

Caption "Write tests in TypeScript" "no config, no tsconfig: the DOM and Intl in them are the browser’s own"
Pane intro
Sleep 600ms
Type "bat test/cart-test.ts"
Enter
Wait /'2 × Tea'\);/
Sleep 4.5s

Caption "Run them in headless Chrome" "test files run in parallel, results stream back as TAP"
Sleep 400ms
Type "qunitx test/"
Enter
Wait /not ok 2/
Pane red
Wait /# duration/
Sleep 3.5s

Caption "--watch" "re-runs on every save, and serves the same page to open yourself"
Pane red
Sleep 400ms
Type "qunitx test/ --watch"
Enter
Wait /# Shortcuts/
Sleep 2.5s
Fix
Wait /# fail 0/
Pane green
Sleep 2.5s
Ctrl+C
Sleep 500ms

Caption "Pick what runs" "list tests by name without a browser, run one by its line"
Sleep 400ms
Type "qunitx test/ -s dom"
Enter
Wait /1 of 5 tests match/
Sleep 1.8s
Type "qunitx test/cart-test.ts#17"
Enter
Wait /ok 1 Cart/
Pane filtered
Wait /# duration/
Sleep 2.5s

Caption "Firefox and WebKit too" "the same suite, any Playwright engine, four reporters"
Sleep 400ms
Type "qunitx test/ --browser=firefox --reporter=spec"
Enter
Wait /passing/
Pane firefox
Sleep 2.2s

Caption "--coverage" "V8 line coverage: a terminal summary, lcov, or this HTML report"
Sleep 400ms
Type "qunitx test/ --coverage=html --reporter=dot"
Enter
Wait /All files/
Pane coverage
Sleep 3.5s

Caption "qunitx repl" "a prompt that evaluates inside the page: its DOM, its fetch, QUnit"
Sleep 400ms
Type "qunitx repl src/cart.ts"
Enter
Wait /type `\.help`/
Pane repl-1
Sleep 800ms
Type "const cart = new Cart().add({ name: 'Coffee', price: 4, qty: 3 })"
Enter
Sleep 500ms
Type "cart.total"
Enter
Wait /^12$/m
Sleep 700ms
Type "document.body.append(cart.render())"
Enter
Pane repl-2
Sleep 1.5s
Type "test('adds up', (assert) => assert.equal(cart.total, 12))"
Enter
Wait /ok 1 adds up/
Pane repl-3
Sleep 3.5s
