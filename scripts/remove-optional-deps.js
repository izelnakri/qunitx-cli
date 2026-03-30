#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
delete pkg.optionalDependencies;
await writeFile('package.json', JSON.stringify(pkg, null, 2) + '\n');
