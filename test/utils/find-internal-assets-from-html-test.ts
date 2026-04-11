import { module, test } from 'qunitx';
import findInternalAssetsFromHTML from '../../lib/utils/find-internal-assets-from-html.ts';

module('Utils | findInternalAssetsFromHTML', { concurrency: true }, () => {
  test('extracts internal script src paths', (assert) => {
    const html = '<html><body><script src="/app.js"></script></body></html>';
    assert.deepEqual(findInternalAssetsFromHTML(html), ['/app.js']);
  });

  test('extracts internal link href paths', (assert) => {
    const html = '<html><head><link href="/styles.css" rel="stylesheet"></head></html>';
    assert.deepEqual(findInternalAssetsFromHTML(html), ['/styles.css']);
  });

  test('returns links before scripts', (assert) => {
    const html = '<html><head><link href="/a.css"><script src="/b.js"></script></head></html>';
    assert.deepEqual(findInternalAssetsFromHTML(html), ['/a.css', '/b.js']);
  });

  test('filters out absolute http:// URLs', (assert) => {
    const html =
      '<html><head><script src="https://cdn.example.com/lib.js"></script><script src="/local.js"></script></head></html>';
    assert.deepEqual(findInternalAssetsFromHTML(html), ['/local.js']);
  });

  test('filters out protocol-relative // URLs', (assert) => {
    const html = '<html><head><script src="//cdn.example.com/lib.js"></script></head></html>';
    assert.deepEqual(findInternalAssetsFromHTML(html), []);
  });

  test('handles type="module" scripts', (assert) => {
    const html = '<html><body><script type="module" src="/mod.js"></script></body></html>';
    assert.deepEqual(findInternalAssetsFromHTML(html), ['/mod.js']);
  });

  test('handles single-quoted attributes', (assert) => {
    const html = "<html><body><script src='/app.js'></script></body></html>";
    assert.deepEqual(findInternalAssetsFromHTML(html), ['/app.js']);
  });

  test('handles href before rel on link', (assert) => {
    const html = '<html><head><link href="/a.css" rel="stylesheet"></head></html>';
    assert.deepEqual(findInternalAssetsFromHTML(html), ['/a.css']);
  });

  test('handles rel before href on link', (assert) => {
    const html = '<html><head><link rel="stylesheet" href="/b.css"></head></html>';
    assert.deepEqual(findInternalAssetsFromHTML(html), ['/b.css']);
  });

  test('returns empty array when no assets', (assert) => {
    const html = '<html><body><p>hello</p></body></html>';
    assert.deepEqual(findInternalAssetsFromHTML(html), []);
  });

  test('multiple scripts and links', (assert) => {
    const html = `<html>
      <head>
        <link href="/qunit.css" rel="stylesheet">
        <link href="https://external.com/x.css" rel="stylesheet">
      </head>
      <body>
        <script src="/vendor/qunit.js"></script>
        <script src="https://cdn.example.com/lib.js"></script>
        <script src="/tests/bundle.js"></script>
      </body>
    </html>`;
    assert.deepEqual(findInternalAssetsFromHTML(html), [
      '/qunit.css',
      '/vendor/qunit.js',
      '/tests/bundle.js',
    ]);
  });
});
