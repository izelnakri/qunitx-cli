#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';

await writeFile(
  'sea-config.json',
  JSON.stringify(
    {
      main: 'sea-entry.cjs',
      output: 'sea.blob',
      disableExperimentalSEAWarning: true,
      useCodeCache: true,
      assets: {
        'setup/tests.hbs': 'templates/setup/tests.hbs',
        'setup/tsconfig.json': 'templates/setup/tsconfig.json',
        'test.js': 'templates/test.js',
        'vendor/qunitx-runtime.js': 'templates/vendor/qunitx-runtime.js',
        'vendor/qunit.css': 'templates/vendor/qunit.css',
      },
    },
    null,
    2,
  ),
);
