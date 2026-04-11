import fs from 'node:fs/promises';
import crypto from 'node:crypto';

export async function writeTestFolder(
  options = { addFailingTests: false, mixedExtensions: false },
) {
  let { addFailingTests, mixedExtensions } = options;
  let folderName = crypto.randomUUID();
  let extension = mixedExtensions ? 'ts' : 'js';
  let [passingsTestTemplate, failingTestTemplate] = await Promise.all([
    fs.readFile(`${process.cwd()}/test/helpers/passing-tests.ts`),
    options.addFailingTests ? fs.readFile(`${process.cwd()}/test/helpers/failing-tests.ts`) : null,
    fs.mkdir(`${process.cwd()}/tmp/${folderName}`, { recursive: true }),
  ]);

  await Promise.all([
    writeTestFile(folderName, 'first-module-pass', 'js', passingsTestTemplate),
    writeTestFile(folderName, 'second-module-pass', extension, passingsTestTemplate),
    addFailingTests
      ? writeTestFile(folderName, 'first-module-fail', 'js', failingTestTemplate)
      : null,
    addFailingTests
      ? writeTestFile(folderName, 'second-module-fail', extension, failingTestTemplate)
      : null,
    addFailingTests
      ? writeTestFile(folderName, 'third-module-fail', extension, failingTestTemplate)
      : null,
  ]);

  return folderName;
}

export function writeTestFile(folderName, testFileName, extension, templateBuffer) {
  return fs.writeFile(
    `${process.cwd()}/tmp/${folderName}/${testFileName}.${extension}`,
    templateBuffer.toString().replace('{{moduleName}}', `${folderName} | ${testFileName}`),
  );
}

/**
 * Creates a temp folder with test files at multiple directory depths:
 *   tmp/{id}/flat.ts
 *   tmp/{id}/subdir/nested.ts
 *   tmp/{id}/subdir/deeper/deep.ts
 *
 * Returns the folder name (UUID) so callers can build expected module names via
 * `${folderName} | flat`, `${folderName} | subdir-nested`, `${folderName} | subdir-deeper-deep`.
 */
export async function writeNestedTestFolder(): Promise<string> {
  const folderName = crypto.randomUUID();
  const base = `${process.cwd()}/tmp/${folderName}`;
  const template = (await fs.readFile(`${process.cwd()}/test/helpers/passing-tests.ts`)).toString();

  await fs.mkdir(`${base}/subdir/deeper`, { recursive: true });

  await Promise.all([
    fs.writeFile(`${base}/flat.ts`, template.replace('{{moduleName}}', `${folderName} | flat`)),
    fs.writeFile(
      `${base}/subdir/nested.ts`,
      template.replace('{{moduleName}}', `${folderName} | subdir-nested`),
    ),
    fs.writeFile(
      `${base}/subdir/deeper/deep.ts`,
      template.replace('{{moduleName}}', `${folderName} | subdir-deeper-deep`),
    ),
  ]);

  return folderName;
}

export default {
  writeTestFolder,
  writeNestedTestFolder,
  writeTestFile,
};
