/**
 * The part of this project's own suite that runs in a browser, as one page.
 *
 * `qunitx test/browser-suite.ts` bundles these files together and runs them in Chrome; CI publishes
 * the same page to GitHub Pages (the `pages` job in ci.yml), so the README can link a live QUnit
 * page that `qunitx <url>` can then run again from anywhere.
 *
 * Membership rule: no `node:` imports, no `process`, and no assertion that only holds outside a
 * browser — a DOM exists here, so a test that expects `inspect(element)` to print like Node's does
 * not belong. Everything here is pure logic over data, which is why it can run in either runtime;
 * `test/runner.ts` still runs each file under node and deno, so the browser is extra coverage
 * rather than the only coverage.
 *
 * One entry rather than eleven inputs is deliberate: qunitx gives each input group its own Chrome,
 * and the suite's Chrome slots are its scarcest resource (see test/helpers/semaphore-server.ts).
 * As one module they share a single page, a single bundle and a single slot.
 */
import './result/result-test.ts';
import './result/try-test.ts';
import './stream/stream-test.ts';
import './selection/qunit-matcher-test.ts';
import './utils/convert-to-pascal-case-test.ts';
import './utils/find-internal-assets-from-html-test.ts';
import './utils/html-test.ts';
import './reporters/reporter-test.ts';
import './api/reporter-test.ts';
import './setup/ws-client-test.ts';
import './commands/daemon/parse-idle-timeout-test.ts';
