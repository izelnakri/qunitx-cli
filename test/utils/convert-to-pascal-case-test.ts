import { module, test } from 'qunitx';
import convertToPascalCase from '../../lib/utils/convert-to-pascal-case.ts';

module('Utils | convertToPascalCase', { concurrency: true }, () => {
  test('converts kebab-case to PascalCase', (assert) => {
    assert.equal(convertToPascalCase('user-contact-details'), 'UserContactDetails');
  });

  test('converts snake_case to PascalCase', (assert) => {
    assert.equal(convertToPascalCase('user_contact_details'), 'UserContactDetails');
  });

  test('converts mixed kebab and snake to PascalCase', (assert) => {
    assert.equal(convertToPascalCase('my_api-handler'), 'MyApiHandler');
  });

  test('capitalises the first letter of camelCase input', (assert) => {
    assert.equal(convertToPascalCase('userContactDetails'), 'UserContactDetails');
  });

  test('leaves PascalCase input unchanged', (assert) => {
    assert.equal(convertToPascalCase('UserContactDetails'), 'UserContactDetails');
  });

  test('handles a single lowercase word', (assert) => {
    assert.equal(convertToPascalCase('user'), 'User');
  });

  test('handles a single uppercase word', (assert) => {
    assert.equal(convertToPascalCase('User'), 'User');
  });

  test('collapses consecutive separators', (assert) => {
    assert.equal(convertToPascalCase('foo--bar__baz'), 'FooBarBaz');
  });

  test('handles an empty string', (assert) => {
    assert.equal(convertToPascalCase(''), '');
  });
});
