import { setupConfig } from '../setup/config.ts';
import { findTests } from '../commands/search.ts';
import { toConfigOverrides } from './options.ts';
import type { DiscoveredTest, SearchOptions } from './types.ts';

/**
 * Lists the tests a selection matches, without running them.
 *
 * Backed by the same static declaration scanner `--search` and `file.ts#34` line targets use:
 * no browser, no bundle, no execution — so it is fast enough to call on every keystroke in an
 * editor integration.
 *
 * ```ts
 * const tests = await search({ files: ['test/'], filter: 'Cart' });
 * tests.forEach((test) => console.log(test.fullName, `${test.file}#${test.line}`));
 * ```
 *
 * A test whose name is computed at runtime (``test(`case ${i}`)``) has no name until the
 * browser runs it, so it cannot be listed — such declarations are omitted rather than guessed.
 */
export async function search(options: SearchOptions = {}): Promise<DiscoveredTest[]> {
  const config = await setupConfig({
    cwd: options.cwd,
    argv: options.files ?? [],
    overrides: { ...toConfigOverrides(options), _embedded: true },
  });

  const { matches } = await findTests(config);

  return matches.map((test) => {
    const module = test.module ? test.module.split(' > ') : [];
    // `location` is the paste-ready `path#line` the CLI prints; the API splits it into the
    // structured pair a consumer would otherwise have to parse back out.
    const separator = test.location.lastIndexOf('#');
    return {
      name: test.testName,
      module,
      fullName: [...module, test.testName].join(' > '),
      file: test.file,
      line: Number(test.location.slice(separator + 1)),
    };
  });
}
