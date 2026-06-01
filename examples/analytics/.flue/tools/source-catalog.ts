import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Type, type ToolDef } from '@flue/runtime';

export const DEFAULT_SOURCE_CATALOG_PATH = 'source_catalog.md';

export function createSourceCatalogTools(): ToolDef[] {
	const sourceCatalogPath = resolveRuntimePath(process.env.SOURCE_CATALOG_PATH || DEFAULT_SOURCE_CATALOG_PATH);
	return [
		{
			name: 'read_source_catalog',
			description: 'Read the source catalog that explains which sources should be searched for which user intents.',
			parameters: Type.Object({}),
			execute: async () => readSourceCatalogText({ sourceCatalogPath }),
		},
	];
}

export async function readSourceCatalogText(input: { sourceCatalogPath?: string } = {}): Promise<string> {
	const sourceCatalogPath = resolveRuntimePath(
		input.sourceCatalogPath || process.env.SOURCE_CATALOG_PATH || DEFAULT_SOURCE_CATALOG_PATH,
	);
	return fs.readFile(sourceCatalogPath, 'utf8');
}

function resolveRuntimePath(value: string): string {
	return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}
