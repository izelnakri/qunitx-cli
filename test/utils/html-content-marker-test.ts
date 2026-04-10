import { module, test } from 'qunitx';
import {
  findHTMLContentMarker,
  htmlHasDynamicContentMarker,
  replaceHTMLContentMarker,
} from '../../lib/utils/html-content-marker.ts';

module('Utils | html content marker', () => {
  test('detects the existing {{qunitxScript}} marker', (assert) => {
    assert.equal(findHTMLContentMarker('<body>{{qunitxScript}}</body>'), '{{qunitxScript}}');
    assert.true(htmlHasDynamicContentMarker('<body>{{qunitxScript}}</body>'));
  });

  test('detects handlebars-like tokens as dynamic html', (assert) => {
    assert.equal(findHTMLContentMarker('<body>{{pageTitle}}</body>'), undefined);
    assert.true(htmlHasDynamicContentMarker('<body>{{pageTitle}}</body>'));
  });

  test('replaces the explicit {{qunitxScript}} marker when present', (assert) => {
    assert.equal(
      replaceHTMLContentMarker('<body>{{qunitxScript}}</body>', '<script>ok</script>'),
      '<body><script>ok</script></body>',
    );
  });

  test('injects before </body> when html is handlebars-like without {{qunitxScript}}', (assert) => {
    assert.equal(
      replaceHTMLContentMarker('<body>{{pageTitle}}</body>', '<script>ok</script>'),
      '<body>{{pageTitle}}<script>ok</script></body>',
    );
  });

  test('leaves static html untouched when no supported marker exists', (assert) => {
    const html = '<body><h1>Static</h1></body>';

    assert.false(htmlHasDynamicContentMarker(html));
    assert.equal(replaceHTMLContentMarker(html, '<script>ok</script>'), html);
  });
});
