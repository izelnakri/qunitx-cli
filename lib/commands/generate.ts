import fs from 'node:fs/promises';
import { green } from '../utils/color.ts';
import { findProjectRoot } from '../utils/find-project-root.ts';
import { pathExists } from '../utils/path-exists.ts';
import { readBoilerplate } from '../utils/read-boilerplate.ts';
import { convertToPascalCase } from '../utils/convert-to-pascal-case.ts';

function pathToModuleName(filePath: string): string {
  const withoutExt = filePath.replace(/\.(js|ts)$/, '');
  const segments = withoutExt.split('/');
  const targetNames =
    segments[0] === 'test' || segments[0] === 'tests' ? segments.slice(1) : segments;
  return targetNames.map(convertToPascalCase).join(' | ');
}

/**
 * Generates a new test file from the boilerplate template.
 * @returns {Promise<void>}
 */
export async function generateTestFiles() {
  const projectRoot = await findProjectRoot();
  const moduleName = pathToModuleName(process.argv[3]);
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

export { generateTestFiles as default };
