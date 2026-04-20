import fs from 'node:fs/promises';
import path from 'node:path';
import { findProjectRoot } from '../utils/find-project-root.ts';
import { pathExists } from '../utils/path-exists.ts';
import { defaultProjectConfigValues } from '../setup/default-project-config-values.ts';
import { readTemplate } from '../utils/read-template.ts';

/** Bootstraps a new qunitx project: writes the test HTML template, updates package.json, and optionally writes tsconfig.json. */
export async function initializeProject() {
  const projectRoot = await findProjectRoot();
  const oldPackageJSON = JSON.parse(await fs.readFile(`${projectRoot}/package.json`));
  const existingQunitx = oldPackageJSON.qunitx || {};
  const cliHtmlPaths = process.argv.slice(2).filter((arg) => arg.endsWith('.html'));
  const config = Object.assign({}, defaultProjectConfigValues, existingQunitx, {
    htmlPaths:
      cliHtmlPaths.length > 0 ? cliHtmlPaths : existingQunitx.htmlPaths || ['test/tests.html'],
  });

  await Promise.all([
    writeTestsHTML(projectRoot, config, oldPackageJSON),
    rewritePackageJSON(projectRoot, config, oldPackageJSON),
    writeTSConfigIfNeeded(projectRoot),
  ]);
}

async function writeTestsHTML(
  projectRoot: string,
  config: { htmlPaths: string[]; output: string },
  oldPackageJSON: Record<string, unknown>,
): Promise<unknown[]> {
  const testHTMLTemplateBuffer = await readTemplate('setup/tests.hbs');

  return await Promise.all(
    config.htmlPaths.map(async (htmlPath) => {
      const targetPath = `${projectRoot}/${htmlPath}`;
      if (await pathExists(targetPath)) {
        return console.log(`${htmlPath} already exists`);
      } else {
        const targetDirectory = path.dirname(targetPath);
        const _targetOutputPath = path.relative(
          targetDirectory,
          path.join(path.resolve(projectRoot, config.output), 'tests.js'),
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

async function rewritePackageJSON(
  projectRoot: string,
  config: unknown,
  oldPackageJSON: Record<string, unknown>,
): Promise<void> {
  const newPackageJSON = Object.assign(oldPackageJSON, { qunitx: config });

  await fs.writeFile(`${projectRoot}/package.json`, JSON.stringify(newPackageJSON, null, 2));
}

async function writeTSConfigIfNeeded(projectRoot: string): Promise<void> {
  const targetPath = `${projectRoot}/tsconfig.json`;
  if (!(await pathExists(targetPath))) {
    const tsConfigTemplate = await readTemplate('setup/tsconfig.json');

    await fs.writeFile(targetPath, tsConfigTemplate);

    console.log(`${targetPath} written`);
  }
}

export { initializeProject as default };
