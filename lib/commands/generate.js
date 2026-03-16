import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import kleur from 'kleur';
import findProjectRoot from '../utils/find-project-root.js';
import pathExists from '../utils/path-exists.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default async function () {
  const projectRoot = await findProjectRoot();
  const moduleName = process.argv[3]; // TODO: classify this maybe in future
  const path =
    process.argv[3].endsWith('.js') || process.argv[3].endsWith('.ts')
      ? `${projectRoot}/${process.argv[3]}`
      : `${projectRoot}/${process.argv[3]}.js`;

  if (await pathExists(path)) {
    return console.log(`${path} already exists!`);
  }

  const testJSContent = await fs.readFile(`${__dirname}/../boilerplates/test.js`);
  const targetFolderPaths = path.split('/');

  targetFolderPaths.pop();

  await fs.mkdir(targetFolderPaths.join('/'), { recursive: true });
  await fs.writeFile(path, testJSContent.toString().replace('{{moduleName}}', moduleName));

  console.log(kleur.green(`${path} written`));
}
