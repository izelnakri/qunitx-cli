const HTML_CONTENT_MARKER = '{{content}}';
const HANDLEBARS_TOKEN_REGEX = /{{\s*[^}]+\s*}}/;

/** Returns the explicit HTML test-content placeholder when it exists in the template. */
export function findHTMLContentMarker(html: string): string | undefined {
  return html.includes(HTML_CONTENT_MARKER) ? HTML_CONTENT_MARKER : undefined;
}

/** Reports whether an HTML template looks dynamic enough to act as a custom runner template. */
export function htmlHasDynamicContentMarker(html: string): boolean {
  return !!findHTMLContentMarker(html) || HANDLEBARS_TOKEN_REGEX.test(html);
}

/** Injects runner content into a dynamic HTML template. */
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
