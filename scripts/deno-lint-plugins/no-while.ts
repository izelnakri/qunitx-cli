// `qunitx/no-while`, loaded through deno.json's `lint.plugins`. Silence it for a line with
// `// deno-lint-ignore qunitx/no-while -- <why>`.

const HINT =
  'Use a for loop with a real update step, an array method (findIndex, some, reduce), or a ' +
  'self-scheduling async function instead.';

/**
 * No `while` or `do … while`. A loop that says where it starts, ends and steps — or a method
 * that names what it looks for — reads better and survives edits better. A loop whose index
 * moves by what each character turns out to be (a lexer's) keeps it, behind a commented ignore.
 *
 * ```ts
 * import plugin from './no-while.ts';
 *
 * Object.keys(plugin.rules); // ['no-while']
 * ```
 */
export default {
  name: 'qunitx',
  rules: {
    'no-while': {
      create(context) {
        return {
          WhileStatement(node) {
            context.report({ node, message: '`while` loops are not used here.', hint: HINT });
          },
          DoWhileStatement(node) {
            context.report({ node, message: '`do … while` loops are not used here.', hint: HINT });
          },
        };
      },
    },
  },
} satisfies Deno.lint.Plugin;
