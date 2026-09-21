import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { module, test } from 'qunitx';
import { findSidecarPlaywrightCore } from '../../lib/utils/import-playwright-core.ts';
import { tempDir } from '../helpers/temp-dir.ts';

// The musl standalone has no project node_modules to resolve playwright-core from, so it ships a
// copy beside the executable. Resolution stays with the CWD everywhere that copy is absent.
module('Utils | importPlaywrightCore | the sidecar', { concurrency: true }, () => {
  test('a playwright-core beside the binary is found, as a file URL import() takes', async (assert) => {
    await using dir = await tempDir('playwright-sidecar');
    const entry = path.join(dir.path, 'node_modules', 'playwright-core', 'index.mjs');
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.writeFile(entry, '');

    assert.strictEqual(findSidecarPlaywrightCore(dir.path), pathToFileURL(entry).href);
  });

  test('none beside it is null, so the import resolves as usual', async (assert) => {
    await using dir = await tempDir('playwright-no-sidecar');

    assert.strictEqual(findSidecarPlaywrightCore(dir.path), null);
  });
});
