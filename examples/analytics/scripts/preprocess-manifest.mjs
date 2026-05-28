#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const DEFAULT_INPUT = '/Users/billgu/Workspace/dbt/target/manifest.json';
const DEFAULT_SCHEMA = 'dbt_prod';

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printHelp();
		return;
	}

	const input = args.input || DEFAULT_INPUT;
	const output = args.inPlace ? input : (args.output || defaultOutputPath(input, args.schema || DEFAULT_SCHEMA));
	const schema = args.schema || process.env.DBT_MANIFEST_QUERY_SCHEMA || DEFAULT_SCHEMA;

	const raw = await fs.readFile(input, 'utf8');
	const manifest = JSON.parse(raw);
	const { normalized, schemas } = normalizeManifestSchemas(manifest, schema);
	await fs.mkdir(path.dirname(output), { recursive: true });
	await fs.writeFile(output, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');

	console.log(JSON.stringify({
		ok: true,
		input,
		output,
		targetSchema: schema,
		replacedSchemas: [...schemas].sort(),
	}, null, 2));

	if (args.upload) uploadToGcs(output, args.upload);
}

export function normalizeManifestSchemas(manifest, targetSchema = DEFAULT_SCHEMA) {
	const schemas = new Set();
	for (const node of Object.values(manifest.nodes || {})) {
		if (node?.database !== 'evenup-bi') continue;
		if (isDevDbtSchema(node?.schema, targetSchema)) schemas.add(node.schema);
	}
	if (schemas.size === 0) return { normalized: manifest, schemas };
	return { normalized: replaceManifestSchemaStrings(manifest, schemas, targetSchema), schemas };
}

function isDevDbtSchema(schema, targetSchema) {
	return Boolean(schema && schema !== targetSchema && /^dbt_[A-Za-z0-9_]+$/.test(schema));
}

function replaceManifestSchemaStrings(value, schemas, targetSchema) {
	if (typeof value === 'string') {
		let result = value;
		for (const schema of schemas) result = result.split(schema).join(targetSchema);
		return result;
	}
	if (Array.isArray(value)) return value.map((item) => replaceManifestSchemaStrings(item, schemas, targetSchema));
	if (value && typeof value === 'object') {
		const result = {};
		for (const [key, item] of Object.entries(value)) {
			result[key] = replaceManifestSchemaStrings(item, schemas, targetSchema);
		}
		return result;
	}
	return value;
}

function parseArgs(argv) {
	const args = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--help' || arg === '-h') args.help = true;
		else if (arg === '--input') args.input = requiredValue(argv, ++index, arg);
		else if (arg === '--output') args.output = requiredValue(argv, ++index, arg);
		else if (arg === '--schema') args.schema = requiredValue(argv, ++index, arg);
		else if (arg === '--upload') args.upload = requiredValue(argv, ++index, arg);
		else if (arg === '--in-place') args.inPlace = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (args.inPlace && args.output) throw new Error('Use either --in-place or --output, not both.');
	return args;
}

function requiredValue(argv, index, flag) {
	const value = argv[index];
	if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
	return value;
}

function defaultOutputPath(input, schema) {
	const parsed = path.parse(input);
	return path.join(parsed.dir, `${parsed.name}.${schema}${parsed.ext}`);
}

function uploadToGcs(localPath, destination) {
	if (!destination.startsWith('gs://')) throw new Error('--upload must be a gs:// path.');
	const result = spawnSync('gcloud', ['storage', 'cp', localPath, destination], {
		stdio: 'inherit',
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`gcloud storage cp exited with status ${result.status}.`);
}

function printHelp() {
	console.log(`Usage:
  node scripts/preprocess-manifest.mjs [options]

Options:
  --input <path>      Source manifest. Defaults to ${DEFAULT_INPUT}
  --output <path>     Destination manifest. Defaults to manifest.<schema>.json next to input
  --in-place          Overwrite the input manifest
  --schema <schema>   Target dbt schema. Defaults to DBT_MANIFEST_QUERY_SCHEMA or ${DEFAULT_SCHEMA}
  --upload <gs://...> Upload the normalized manifest with gcloud storage cp
`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
