// The canonical placeholder that marks where qunitx injects its test runner script block
// (WebSocket setup + QUnit hooks + bundled test code) into a custom HTML template.
// Any other handlebars-style token (e.g. {{applicationName}}) also qualifies the template
// as "dynamic" so qunitx still injects before </body> when this exact marker is absent.
const SCRIPT_PLACEHOLDER = '{{qunitxScript}}';
const HANDLEBARS_TOKEN_REGEX = /{{\s*[^}]+\s*}}/;

/** Returns the explicit `{{qunitxScript}}` placeholder when it exists in the template. */
export function findScriptPlaceholder(html: string): string | undefined {
  return html.includes(SCRIPT_PLACEHOLDER) ? SCRIPT_PLACEHOLDER : undefined;
}

/** Reports whether an HTML template looks dynamic enough to act as a custom runner template. */
export function isCustomTemplate(html: string): boolean {
  return !!findScriptPlaceholder(html) || HANDLEBARS_TOKEN_REGEX.test(html);
}

/** Injects the qunitx runner script block into a dynamic HTML template. */
export function injectScript(html: string, content: string): string {
  const placeholder = findScriptPlaceholder(html);

  if (placeholder) {
    return html.replace(placeholder, content);
  }

  if (isCustomTemplate(html)) {
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
