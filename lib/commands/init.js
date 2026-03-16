import fs from 'node:fs/promises';
import path from 'node:path';
import findProjectRoot from '../utils/find-project-root.js';
import pathExists from '../utils/path-exists.js';
import defaultProjectConfigValues from '../boilerplates/default-project-config-values.js';
import readBoilerplate from '../utils/read-boilerplate.js';

export default async function () {
  const projectRoot = await findProjectRoot();
  const oldPackageJSON = JSON.parse(await fs.readFile(`${projectRoot}/package.json`));
  const htmlPaths = process.argv.slice(2).reduce(
    (result, arg) => {
      if (arg.endsWith('.html')) {
        result.push(arg);
      }

      return result;
    },
    oldPackageJSON.qunitx && oldPackageJSON.qunitx.htmlPaths ? oldPackageJSON.qunitx.htmlPaths : [],
  );
  const newQunitxConfig = Object.assign(
    defaultProjectConfigValues,
    htmlPaths.length > 0 ? { htmlPaths } : { htmlPaths: ['test/tests.html'] },
    oldPackageJSON.qunitx,
  );

  await Promise.all([
    writeTestsHTML(projectRoot, newQunitxConfig, oldPackageJSON),
    rewritePackageJSON(projectRoot, newQunitxConfig, oldPackageJSON),
    writeTSConfigIfNeeded(projectRoot),
  ]);
}

async function writeTestsHTML(projectRoot, newQunitxConfig, oldPackageJSON) {
  const testHTMLTemplateBuffer = await readBoilerplate('setup/tests.hbs');

  return await Promise.all(
    newQunitxConfig.htmlPaths.map(async (htmlPath) => {
      const targetPath = `${projectRoot}/${htmlPath}`;
      if (await pathExists(targetPath)) {
        return console.log(`${htmlPath} already exists`);
      } else {
        const targetDirectory = path.dirname(targetPath);
        const _targetOutputPath = path.relative(
          targetDirectory,
          `${projectRoot}/${newQunitxConfig.output}/tests.js`,
        );
        const testHTMLTemplate = testHTMLTemplateBuffer.replace(
          '{{applicationName}}',
          oldPackageJSON.name,
        );

        await fs.mkdir(targetDirectory, { recursive: true });
        await fs.writeFile(targetPath, testHTMLTemplate);

        console.log(`${targetPath} written`);
      }
    }),
  );
}

async function rewritePackageJSON(projectRoot, newQunitxConfig, oldPackageJSON) {
  const newPackageJSON = Object.assign(oldPackageJSON, { qunitx: newQunitxConfig });

  await fs.writeFile(`${projectRoot}/package.json`, JSON.stringify(newPackageJSON, null, 2));
}

async function writeTSConfigIfNeeded(projectRoot) {
  const targetPath = `${projectRoot}/tsconfig.json`;
  if (!(await pathExists(targetPath))) {
    const tsConfigTemplate = await readBoilerplate('setup/tsconfig.json');

    await fs.writeFile(targetPath, tsConfigTemplate);

    console.log(`${targetPath} written`);
  }
}
