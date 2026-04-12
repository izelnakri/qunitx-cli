const ABSOLUTE_URL_REGEX = /^(?:[a-z]+:)?\/\//i;
const SCRIPT_SRC_REGEX = /<script[^>]+\bsrc=['"]([^'"]+)['"]/gi;
const LINK_HREF_REGEX = /<link[^>]+\bhref=['"]([^'"]+)['"]/gi;

/**
 * Parses an HTML string and returns all internal (non-absolute-URL) `<script src>` and `<link href>` paths.
 * @returns {string[]}
 */
export function findInternalAssetsFromHTML(htmlContent: string): string[] {
  const links = [...htmlContent.matchAll(LINK_HREF_REGEX)]
    .map((match) => match[1])
    .filter((uri) => !ABSOLUTE_URL_REGEX.test(uri));
  const scripts = [...htmlContent.matchAll(SCRIPT_SRC_REGEX)]
    .map((match) => match[1])
    .filter((uri) => !ABSOLUTE_URL_REGEX.test(uri));

  return links.concat(scripts);
}

export { findInternalAssetsFromHTML as default };
