/**
 * Converts a kebab-case, snake_case, camelCase, or PascalCase string to PascalCase.
 * Splits on `-` and `_` word boundaries; internal capitals in camelCase/PascalCase
 * are preserved as-is.
 *
 * @example
 * convertToPascalCase('user-contact-details') // 'UserContactDetails'
 * convertToPascalCase('user_contact_details') // 'UserContactDetails'
 * convertToPascalCase('userContactDetails')   // 'UserContactDetails'
 * convertToPascalCase('UserContactDetails')   // 'UserContactDetails'
 * convertToPascalCase('my_api-handler')       // 'MyApiHandler'
 */
export function convertToPascalCase(str: string): string {
  return str
    .split(/[-_]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

export { convertToPascalCase as default };
