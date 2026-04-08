import { module, test } from 'qunitx';
import {
  findHTMLContentMarker,
  htmlHasDynamicContentMarker,
  replaceHTMLContentMarker,
} from '../../lib/utils/html-content-marker.ts';

module('Utils | html content marker', () => {
  test('detects the existing {{content}} marker', (assert) => {
    assert.equal(findHTMLContentMarker('<body>{{content}}</body>'), '{{content}}');
    assert.true(htmlHasDynamicContentMarker('<body>{{content}}</body>'));
  });

  test('detects handlebars-like tokens as dynamic html', (assert) => {
    assert.equal(findHTMLContentMarker('<body>{{pageTitle}}</body>'), undefined);
    assert.true(htmlHasDynamicContentMarker('<body>{{pageTitle}}</body>'));
  });

  test('replaces the explicit {{content}} marker when present', (assert) => {
    assert.equal(
      replaceHTMLContentMarker('<body>{{content}}</body>', '<script>ok</script>'),
      '<body><script>ok</script></body>',
    );
  });

  test('injects before </body> when html is handlebars-like without {{content}}', (assert) => {
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
