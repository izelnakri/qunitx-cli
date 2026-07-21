/**
 * A faithful port of QUnit's own `config.filter` matcher, for matching tests WITHOUT a browser.
 *
 * `--search` previews which tests a filter selects by scanning source statically, so it cannot ask
 * QUnit — but it must agree with QUnit exactly, or the preview would lie about the real run. Every
 * function here mirrors `Test.prototype.valid` / `regexFilter` / `stringFilter` in
 * templates/vendor/qunitx-runtime.js line-for-line; change them only to track an upstream change.
 */

/** QUnit's regex-filter syntax: an optional leading `!`, a `/…/` body, and an optional `i` flag. */
const REGEX_FILTER = /^(!?)\/([\w\W]*)\/(i?$)/;

/**
 * The string a filter is matched against: `"Module: test name"`, with nested modules already
 * joined by `" > "`. A top-level test has an empty module name, giving `": test name"` — which is
 * QUnit's own behaviour, not a quirk of this port.
 */
export function buildQUnitFullName(modulePath: string, testName: string): string {
  return `${modulePath}: ${testName}`;
}

/**
 * True when `filter` selects `fullName`, using QUnit's semantics:
 * - `/re/` or `/re/i` — regex (case-SENSITIVE without the `i` flag)
 * - anything else — case-INSENSITIVE substring
 * - a leading `!` inverts either form
 *
 * An empty/absent filter matches everything, mirroring QUnit's `if (filter)` guard.
 */
export function matchQUnitFilter(filter: string | undefined, fullName: string): boolean {
  if (!filter) {
    return true;
  }

  const regexFilter = REGEX_FILTER.exec(filter);
  if (regexFilter) {
    const exclude = Boolean(regexFilter[1]);
    // An invalid pattern throws inside QUnit too (surfacing as a global failure there); here the
    // caller gets a clean error rather than a preview that silently matches nothing.
    const regex = new RegExp(regexFilter[2], regexFilter[3]);

    return regex.test(fullName) !== exclude;
  }

  return stringFilter(filter, fullName);
}

/** Case-insensitive substring match; a leading `!` inverts. */
function stringFilter(filter: string, fullName: string): boolean {
  const needle = filter.toLowerCase();
  const haystack = fullName.toLowerCase();
  const include = needle.charAt(0) !== '!';

  return haystack.includes(include ? needle : needle.slice(1)) === include;
}
