import fs from 'node:fs/promises';
import { green } from '../utils/color.ts';
import findProjectRoot from '../utils/find-project-root.ts';
import pathExists from '../utils/path-exists.ts';
import readBoilerplate from '../utils/read-boilerplate.ts';

/**
 * Generates a new test file from the boilerplate template.
 * @returns {Promise<void>}
 */
export default async function generateTestFiles() {
  const projectRoot = await findProjectRoot();
  const moduleName = process.argv[3];
  const path =
    process.argv[3].endsWith('.js') || process.argv[3].endsWith('.ts')
      ? `${projectRoot}/${process.argv[3]}`
      : `${projectRoot}/${process.argv[3]}.js`;

  if (await pathExists(path)) {
    console.log(`${path} already exists!`);
    return;
  }

  const testJSContent = await readBoilerplate('test.js');
  const targetFolderPaths = path.split('/');

  targetFolderPaths.pop();

  await fs.mkdir(targetFolderPaths.join('/'), { recursive: true });
  await fs.writeFile(path, testJSContent.replace('{{moduleName}}', moduleName));

  console.log(green(`${path} written`));
}
