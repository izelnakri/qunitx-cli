import { module, test } from 'qunitx';
import fs from 'node:fs/promises';

// A test that writes a script for a child process has to name its imports as file URLs. A path
// works on POSIX, where `/home/…` has no scheme, and fails on Windows, where `C:\…` is read as a
// URL with the scheme `c:` — both runtimes refuse it, so the Windows lanes are the first to see it.
// That shipped once (reserve-port-test.ts); this checks every generated import in the suite.
const GENERATED_IMPORT = /(?:\bfrom |\bimport\()\$\{JSON\.stringify\((\w+)\)\}/g;

module('Helpers | generated imports', () => {
  test('every import a test generates for a child names a file URL, not a path', async (assert) => {
    const offenders: string[] = [];
    let checked = 0;
    for await (const file of fs.glob('test/**/*.ts')) {
      if (file.endsWith('generated-imports-test.ts')) continue; // its own examples, below
      const source = await fs.readFile(file, 'utf8');
      for (const [, name] of source.matchAll(GENERATED_IMPORT)) {
        checked += 1;
        if (!builtAsUrl(source, name!)) offenders.push(`${file}: ${name}`);
      }
    }

    assert.true(checked > 0, 'the pattern still finds the generated imports it is meant to check');
    assert.deepEqual(offenders, [], 'build them with `new URL(…, import.meta.url).href`');
  });

  test('the check catches the shape that broke Windows, and passes the fixed one', (assert) => {
    const broken =
      "const helper = path.resolve('a.ts');\nconst s = `from ${JSON.stringify(helper)}`;";
    const fixed =
      "const helper = new URL('./a.ts', import.meta.url).href;\nconst s = `from ${JSON.stringify(helper)}`;";

    assert.false(builtAsUrl(broken, 'helper'));
    assert.true(builtAsUrl(fixed, 'helper'));
  });
});

/** Whether `name` is assigned a file URL — `new URL(...).href` or `pathToFileURL(...).href`. */
function builtAsUrl(source: string, name: string): boolean {
  const assignment = source.match(new RegExp(`\\b(?:const|let)\\s+${name}\\s*=\\s*([^;]+);`));

  return (
    assignment !== null &&
    /\bnew URL\(|\bpathToFileURL\(/.test(assignment[1]!) &&
    /\.href\b/.test(assignment[1]!)
  );
}
