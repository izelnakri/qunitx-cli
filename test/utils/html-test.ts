import { module, test } from 'qunitx';
import { findScriptPlaceholder, isCustomTemplate, injectScript } from '../../lib/utils/html.ts';

module('Utils | html', { concurrency: true }, () => {
  test('detects the existing {{qunitxScript}} marker', (assert) => {
    assert.equal(findScriptPlaceholder('<body>{{qunitxScript}}</body>'), '{{qunitxScript}}');
    assert.true(isCustomTemplate('<body>{{qunitxScript}}</body>'));
  });

  test('detects handlebars-like tokens as dynamic html', (assert) => {
    assert.equal(findScriptPlaceholder('<body>{{pageTitle}}</body>'), undefined);
    assert.true(isCustomTemplate('<body>{{pageTitle}}</body>'));
  });

  test('replaces the explicit {{qunitxScript}} marker when present', (assert) => {
    assert.equal(
      injectScript('<body>{{qunitxScript}}</body>', '<script>ok</script>'),
      '<body><script>ok</script></body>',
    );
  });

  test('injects before </body> when html is handlebars-like without {{qunitxScript}}', (assert) => {
    assert.equal(
      injectScript('<body>{{pageTitle}}</body>', '<script>ok</script>'),
      '<body>{{pageTitle}}<script>ok</script></body>',
    );
  });

  test('leaves static html untouched when no supported marker exists', (assert) => {
    const html = '<body><h1>Static</h1></body>';

    assert.false(isCustomTemplate(html));
    assert.equal(injectScript(html, '<script>ok</script>'), html);
  });
});
