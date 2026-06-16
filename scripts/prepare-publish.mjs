#!/usr/bin/env node
/**
 * Prepares publish artifacts for all public packages:
 * - Copies `apps/docs/src/content/docs` into `<package>/docs` for agent consumption.
 * - Syncs the root README.md into the core packages (cli, runtime, sdk).
 *
 * Run from anywhere: `node scripts/prepare-publish.mjs`
 */
import { copyFile, cp, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const docsSource = join(repoRoot, 'apps/docs/src/content/docs');
const readmeSource = join(repoRoot, 'README.md');

const README_SYNC_PACKAGES = new Set(['@flue/cli', '@flue/runtime', '@flue/sdk']);

const packagesDir = join(repoRoot, 'packages');
for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
	if (!entry.isDirectory()) {
		continue;
	}
	const packageRoot = join(packagesDir, entry.name);
	let manifest;
	try {
		manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
	} catch {
		continue;
	}
	if (manifest.private === true) {
		continue;
	}

	const docsTarget = join(packageRoot, 'docs');
	await rm(docsTarget, { force: true, recursive: true });
	await cp(docsSource, docsTarget, { recursive: true });

	if (README_SYNC_PACKAGES.has(manifest.name)) {
		await copyFile(readmeSource, join(packageRoot, 'README.md'));
	}

	console.error(`[flue] Prepared publish artifacts for ${manifest.name}`);
}
