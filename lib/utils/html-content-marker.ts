// The canonical placeholder that marks where qunitx injects its test runner script block
// (WebSocket setup + QUnit hooks + bundled test code) into a custom HTML template.
// Any other handlebars-style token (e.g. {{applicationName}}) also qualifies the template
// as "dynamic" so qunitx still injects before </body> when this exact marker is absent.
const HTML_CONTENT_MARKER = '{{qunitxScript}}';
const HANDLEBARS_TOKEN_REGEX = /{{\s*[^}]+\s*}}/;

/** Returns the explicit `{{qunitxScript}}` placeholder when it exists in the template. */
export function findHTMLContentMarker(html: string): string | undefined {
  return html.includes(HTML_CONTENT_MARKER) ? HTML_CONTENT_MARKER : undefined;
}

/** Reports whether an HTML template looks dynamic enough to act as a custom runner template. */
export function htmlHasDynamicContentMarker(html: string): boolean {
  return !!findHTMLContentMarker(html) || HANDLEBARS_TOKEN_REGEX.test(html);
}

/** Injects the qunitx runner script block into a dynamic HTML template. */
export function replaceHTMLContentMarker(html: string, content: string): string {
  const marker = findHTMLContentMarker(html);

  if (marker) {
    return html.replace(marker, content);
  }

  if (htmlHasDynamicContentMarker(html)) {
    if (html.includes('</body>')) {
      return html.replace('</body>', `${content}</body>`);
    }

    if (html.includes('</html>')) {
      return html.replace('</html>', `${content}</html>`);
    }

    return `${html}${content}`;
  }

  return html;
}
