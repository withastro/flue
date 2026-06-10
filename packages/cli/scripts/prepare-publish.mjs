#!/usr/bin/env node
import { cp, copyFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const repoRoot = join(packageRoot, '../..');

const readmeSource = join(repoRoot, 'README.md');
const readmeTarget = join(packageRoot, 'README.md');
const docsSource = join(repoRoot, 'apps/docs/src/content/docs');
const docsTarget = join(packageRoot, 'docs');

await copyFile(readmeSource, readmeTarget);
await rm(docsTarget, { force: true, recursive: true });
await cp(docsSource, docsTarget, { recursive: true });

console.error('[flue] Prepared @flue/cli publish artifacts: README.md and docs/');
