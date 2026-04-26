import { module, test } from 'qunitx';

module('.jsx files are auto-discovered (default extensions)', function () {
  test('JSX automatic runtime produces a valid React element', function (assert) {
    const element = <section className="hello">world</section>;
    assert.equal(typeof element, 'object', 'JSX returns an object');
    assert.equal(element.type, 'section', 'element type matches the tag');
    assert.equal(element.props.className, 'hello', 'attribute compiles to props');
    assert.equal(element.props.children, 'world', 'text child compiles to props.children');
  });
});
