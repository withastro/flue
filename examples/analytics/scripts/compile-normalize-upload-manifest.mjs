#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeManifestSchemas } from './preprocess-manifest.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DBT_DIR = path.resolve(SCRIPT_DIR, '../../../..', 'dbt');
const DEFAULT_SCHEMA = 'dbt_prod';
const DEFAULT_BUCKET = 'evenup-internal-tools-dev-dbt-explorer-api';
const DEFAULT_OBJECT = 'dbt-explorer/manifest/manifest.json';

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printHelp();
		return;
	}

	const dbtDir = path.resolve(args.dbtDir || DEFAULT_DBT_DIR);
	const schema = args.schema || process.env.DBT_MANIFEST_QUERY_SCHEMA || DEFAULT_SCHEMA;
	const manifestPath = resolveAgainst(dbtDir, args.manifest || 'target/manifest.json');
	const outputPath = resolveAgainst(dbtDir, args.output || `target/manifest.${schema}.json`);
	const gcsUri = args.gcsUri || process.env.DBT_MANIFEST_GCS_URI || defaultGcsUri();

	if (!args.skipGitSync) {
		run('git', ['checkout', 'main'], { cwd: dbtDir });
		run('git', ['pull'], { cwd: dbtDir });
	}
	if (!args.skipCompile) run('dbt', ['compile'], { cwd: dbtDir });

	const raw = await fs.readFile(manifestPath, 'utf8');
	const { normalized, schemas } = normalizeManifestSchemas(JSON.parse(raw), schema);
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	await fs.writeFile(outputPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');

	console.log(JSON.stringify({
		ok: true,
		dbtDir,
		manifestPath,
		outputPath,
		targetSchema: schema,
		replacedSchemas: [...schemas].sort(),
		gcsUri: args.noUpload ? undefined : gcsUri,
	}, null, 2));

	if (!args.noUpload) run('gcloud', ['storage', 'cp', outputPath, gcsUri]);
}

function parseArgs(argv) {
	const args = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--help' || arg === '-h') args.help = true;
		else if (arg === '--dbt-dir') args.dbtDir = requiredValue(argv, ++index, arg);
		else if (arg === '--manifest') args.manifest = requiredValue(argv, ++index, arg);
		else if (arg === '--output') args.output = requiredValue(argv, ++index, arg);
		else if (arg === '--schema') args.schema = requiredValue(argv, ++index, arg);
		else if (arg === '--gcs-uri') args.gcsUri = requiredValue(argv, ++index, arg);
		else if (arg === '--skip-git-sync') args.skipGitSync = true;
		else if (arg === '--skip-compile') args.skipCompile = true;
		else if (arg === '--no-upload') args.noUpload = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return args;
}

function requiredValue(argv, index, flag) {
	const value = argv[index];
	if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
	return value;
}

function resolveAgainst(root, value) {
	return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function defaultGcsUri() {
	const bucket = process.env.GCS_BUCKET || process.env.FLUE_ARTIFACT_BUCKET || DEFAULT_BUCKET;
	return `gs://${bucket}/${DEFAULT_OBJECT}`;
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		stdio: 'inherit',
		env: process.env,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}.`);
}

function printHelp() {
	console.log(`Usage:
  node scripts/compile-normalize-upload-manifest.mjs [options]

Runs locally:
  1. git checkout main && git pull
  2. dbt compile
  3. normalize target/manifest.json schemas to dbt_prod
  4. upload normalized manifest to GCS

Options:
  --dbt-dir <path>    dbt repo path. Defaults to ${displayPath(DEFAULT_DBT_DIR)}
  --manifest <path>   Manifest path, relative to dbt dir unless absolute. Defaults to target/manifest.json
  --output <path>     Normalized output path. Defaults to target/manifest.<schema>.json
  --schema <schema>   Target dbt schema. Defaults to DBT_MANIFEST_QUERY_SCHEMA or ${DEFAULT_SCHEMA}
  --gcs-uri <uri>     Upload destination. Defaults to gs://$GCS_BUCKET/${DEFAULT_OBJECT}
  --skip-git-sync     Do not run git checkout main or git pull
  --skip-compile      Normalize/upload existing manifest without running dbt compile
  --no-upload         Compile and normalize only
`);
}

function displayPath(value) {
	const relative = path.relative(process.cwd(), value);
	return relative || '.';
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
