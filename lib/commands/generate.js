import fs from 'node:fs/promises';
import kleur from 'kleur';
import findProjectRoot from '../utils/find-project-root.js';
import pathExists from '../utils/path-exists.js';
import readBoilerplate from '../utils/read-boilerplate.js';

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

  const testJSContent = await readBoilerplate('test.js');
  const targetFolderPaths = path.split('/');

  targetFolderPaths.pop();

  await fs.mkdir(targetFolderPaths.join('/'), { recursive: true });
  await fs.writeFile(path, testJSContent.replace('{{moduleName}}', moduleName));

  console.log(kleur.green(`${path} written`));
}
