import * as fs from 'node:fs/promises';

export const DEFAULT_MANIFEST_PATH = 'resources/manifest/manifest.json';

export type ManifestSearchType = 'name' | 'column' | 'description' | 'all';
export type ManifestSearchLogic = 'and' | 'or';
export type LineageDirection = 'upstream' | 'downstream' | 'both';

interface ManifestColumn {
	name?: string;
	description?: string;
	type?: string;
	data_type?: string;
}

interface ManifestNode {
	resource_type?: string;
	name?: string;
	description?: string;
	database?: string;
	schema?: string;
	alias?: string;
	original_file_path?: string;
	raw_code?: string;
	columns?: Record<string, ManifestColumn>;
}

interface DbtManifest {
	nodes?: Record<string, ManifestNode>;
	parent_map?: Record<string, string[]>;
	child_map?: Record<string, string[]>;
}

export interface SlimManifestNode {
	name: string;
	description: string;
	relation_name: string;
	path: string;
	sql?: string;
	matched_columns?: Array<{ column: string; description: string }>;
	matched_fields?: string[];
	match_reason?: string;
	depth?: number;
}

export interface ManifestSearchInput {
	manifestPath: string;
	keywords: string[];
	searchType?: ManifestSearchType;
	logic?: ManifestSearchLogic;
	includeSql?: boolean;
}

export interface ModelDetailsInput {
	manifestPath: string;
	modelName: string;
	includeSql?: boolean;
	columnLimit?: number;
}

export interface ModelDetails {
	name: string;
	description: string;
	relation_name: string;
	path: string;
	columns: Array<{ name: string; description: string; type?: string }>;
	column_count: number;
	columns_truncated: boolean;
	upstream_models: string[];
	downstream_models: string[];
	sql?: string;
}

const layerOrder: Record<string, number> = { mart: 0, fct: 1, dim: 2, int: 3, stg: 4 };
const truncationLayerOrder: Record<string, number> = { mart: 0, dim: 1, fct: 2, stg: 3 };
const maxResults = 10;
const manifestCache = new Map<string, { mtimeMs: number; size: number; manifest: DbtManifest }>();

export async function loadManifest(manifestPath: string): Promise<DbtManifest> {
	const stat = await fs.stat(manifestPath);
	const cached = manifestCache.get(manifestPath);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return cached.manifest;
	}

	const raw = await fs.readFile(manifestPath, 'utf8');
	const manifest = JSON.parse(raw) as DbtManifest;
	manifestCache.set(manifestPath, { mtimeMs: stat.mtimeMs, size: stat.size, manifest });
	return manifest;
}

export async function searchManifest(input: ManifestSearchInput): Promise<
	| SlimManifestNode[]
	| {
			truncated: true;
			total_matches: number;
			hint: string;
			top_10: Array<{ name: string; description: string }>;
			logic_used?: string;
	  }
	| { logic_used: string; results: SlimManifestNode[] }
> {
	const manifest = await loadManifest(input.manifestPath);
	const keywords = input.keywords.map((keyword) => keyword.toLowerCase().trim()).filter(Boolean);
	if (keywords.length === 0) {
		throw new Error('At least one keyword is required.');
	}

	const searchType = input.searchType ?? 'all';
	const logic = input.logic ?? 'and';
	let results = collectMatches(manifest.nodes ?? {}, keywords, searchType, logic);

	let fallbackMessage: string | undefined;
	if (logic === 'and' && keywords.length > 1 && results.length === 0) {
		results = collectMatches(manifest.nodes ?? {}, keywords, searchType, 'or');
		fallbackMessage = 'or (and returned 0 results)';
	}

	return formatResults(results, fallbackMessage, input.includeSql ?? false);
}

export async function getModelDetails(input: ModelDetailsInput): Promise<ModelDetails | { error: string }> {
	const manifest = await loadManifest(input.manifestPath);
	const nodes = manifest.nodes ?? {};
	const entry = findModelEntry(nodes, input.modelName);
	if (!entry) return { error: `Model '${input.modelName}' not found in manifest.` };

	const [nodeKey, node] = entry;
	const allColumns = Object.entries(node.columns ?? {}).map(([name, column]) => ({
		name,
		description: column.description ?? '',
		type: column.data_type ?? column.type,
	}));
	const columnLimit = input.columnLimit ?? 80;
	const columns = allColumns.slice(0, columnLimit);
	const upstreamModels = modelNamesForKeys(nodes, manifest.parent_map?.[nodeKey] ?? []);
	const downstreamModels = modelNamesForKeys(nodes, manifest.child_map?.[nodeKey] ?? []);
	const details: ModelDetails = {
		...baseNode(node),
		columns,
		column_count: allColumns.length,
		columns_truncated: allColumns.length > columns.length,
		upstream_models: upstreamModels,
		downstream_models: downstreamModels,
	};
	if (input.includeSql) details.sql = node.raw_code ?? '';
	return details;
}

export async function modelLineage(input: {
	manifestPath: string;
	modelName: string;
	direction?: LineageDirection;
	depth?: number;
	includeSql?: boolean;
}): Promise<SlimManifestNode[] | Array<{ error: string }>> {
	const manifest = await loadManifest(input.manifestPath);
	const nodes = manifest.nodes ?? {};
	const parentMap = manifest.parent_map ?? {};
	const childMap = manifest.child_map ?? {};
	const direction = input.direction ?? 'both';
	const maxDepth = input.depth ?? 2;

	const rootKey = findModelEntry(nodes, input.modelName)?.[0];
	if (!rootKey) {
		return [{ error: `Model '${input.modelName}' not found in manifest.` }];
	}

	const seen = new Set([rootKey]);
	const result: Array<{ depth: number; node: SlimManifestNode }> = [];

	const bfs = (startKey: string, neighbors: Record<string, string[]>, sign: -1 | 1) => {
		const queue: Array<{ key: string; depth: number }> = [{ key: startKey, depth: 0 }];
		while (queue.length > 0) {
			const current = queue.shift();
			if (!current) break;
			if (current.depth > maxDepth) continue;

			if (current.depth > 0) {
				const node = nodes[current.key];
				if (node && isModel(node) && !seen.has(current.key)) {
					seen.add(current.key);
					const slim = slimNode(node, undefined, input.includeSql ?? false);
					slim.depth = sign * current.depth;
					result.push({ depth: sign * current.depth, node: slim });
				}
			}

			for (const neighbor of neighbors[current.key] ?? []) {
				if (!seen.has(neighbor) && neighbor.startsWith('model.')) {
					queue.push({ key: neighbor, depth: current.depth + 1 });
				}
			}
		}
	};

	if (direction === 'upstream' || direction === 'both') bfs(rootKey, parentMap, -1);
	if (direction === 'downstream' || direction === 'both') bfs(rootKey, childMap, 1);

	result.sort((a, b) => a.depth - b.depth || a.node.name.localeCompare(b.node.name));
	const root = slimNode(nodes[rootKey]!, undefined, input.includeSql ?? false);
	root.depth = 0;

	return [
		...result.filter((item) => item.depth < 0).map((item) => item.node),
		root,
		...result.filter((item) => item.depth > 0).map((item) => item.node),
	];
}

function isModel(node: ManifestNode): boolean {
	return node.resource_type === 'model';
}

function slimNode(
	node: ManifestNode,
	matchedColumns?: Array<{ column: string; description: string }>,
	includeSql = false,
	match?: { fields: string[]; reason: string },
): SlimManifestNode {
	const result: SlimManifestNode = {
		...baseNode(node),
	};
	if (includeSql) result.sql = node.raw_code ?? '';
	if (matchedColumns && matchedColumns.length > 0) result.matched_columns = matchedColumns;
	if (match) {
		result.matched_fields = match.fields;
		result.match_reason = match.reason;
	}
	return result;
}

function collectMatches(
	nodes: Record<string, ManifestNode>,
	keywords: string[],
	searchType: ManifestSearchType,
	logic: ManifestSearchLogic,
): Array<{
	node: ManifestNode;
	bestType: number;
	matchedColumns: Array<{ column: string; description: string }>;
	matchedFields: string[];
	matchReason: string;
}> {
	const results = [];
	for (const node of Object.values(nodes)) {
		if (!isModel(node)) continue;
		const keywordResults = keywords.map((keyword) => nodeMatchesKeyword(node, keyword, searchType));
		const matched = logic === 'and'
			? keywordResults.every((result) => result.matched)
			: keywordResults.some((result) => result.matched);
		if (!matched) continue;

		const columnsByName = new Map<string, { column: string; description: string }>();
		const fields = new Set<string>();
		const reasons: string[] = [];
		for (const result of keywordResults) {
			if (!result.matched) continue;
			for (const field of result.matchedFields) fields.add(field);
			reasons.push(result.reason);
			for (const column of result.matchedColumns) columnsByName.set(column.column, column);
		}

		results.push({
			node,
			bestType: Math.min(...keywordResults.filter((result) => result.matched).map((result) => result.matchType)),
			matchedColumns: [...columnsByName.values()],
			matchedFields: [...fields],
			matchReason: reasons.join('; '),
		});
	}
	return results;
}

function nodeMatchesKeyword(
	node: ManifestNode,
	keyword: string,
	searchType: ManifestSearchType,
): {
	matched: boolean;
	matchType: number;
	matchedColumns: Array<{ column: string; description: string }>;
	matchedFields: string[];
	reason: string;
} {
	const identifierKeyword = keyword.replaceAll(' ', '_');
	const name = (node.name ?? '').toLowerCase();
	const description = (node.description ?? '').toLowerCase();

	if ((searchType === 'name' || searchType === 'all') && name.includes(identifierKeyword)) {
		return {
			matched: true,
			matchType: 0,
			matchedColumns: [],
			matchedFields: ['name'],
			reason: `keyword "${keyword}" matched model name`,
		};
	}

	if ((searchType === 'description' || searchType === 'all') && description.includes(keyword)) {
		return {
			matched: true,
			matchType: 1,
			matchedColumns: [],
			matchedFields: ['description'],
			reason: `keyword "${keyword}" matched model description`,
		};
	}

	if (searchType === 'column' || searchType === 'all') {
		const matchedColumns = [];
		let bestColumnType = 99;
		const matchedFields = new Set<string>();
		for (const [columnName, columnMeta] of Object.entries(node.columns ?? {})) {
			const columnDescription = (columnMeta.description ?? '').toLowerCase();
			if (columnName.toLowerCase().includes(identifierKeyword)) {
				matchedColumns.push({ column: columnName, description: columnMeta.description ?? '' });
				bestColumnType = Math.min(bestColumnType, 2);
				matchedFields.add('column_name');
			} else if (columnDescription.includes(keyword)) {
				matchedColumns.push({ column: columnName, description: columnMeta.description ?? '' });
				bestColumnType = Math.min(bestColumnType, 3);
				matchedFields.add('column_description');
			}
		}
		if (matchedColumns.length > 0) {
			return {
				matched: true,
				matchType: bestColumnType,
				matchedColumns,
				matchedFields: [...matchedFields],
				reason: `keyword "${keyword}" matched ${matchedColumns.length} column(s)`,
			};
		}
	}

	return { matched: false, matchType: 99, matchedColumns: [], matchedFields: [], reason: '' };
}

function formatResults(
	results: Array<{
		node: ManifestNode;
		bestType: number;
		matchedColumns: Array<{ column: string; description: string }>;
		matchedFields: string[];
		matchReason: string;
	}>,
	fallbackMessage: string | undefined,
	includeSql: boolean,
) {
	results.sort((a, b) =>
		layerRank(a.node.name ?? '', layerOrder) - layerRank(b.node.name ?? '', layerOrder) ||
		a.bestType - b.bestType,
	);

	if (results.length > maxResults) {
		results.sort((a, b) =>
			layerRank(a.node.name ?? '', truncationLayerOrder) - layerRank(b.node.name ?? '', truncationLayerOrder) ||
			a.bestType - b.bestType,
		);
		const output = {
			truncated: true as const,
			total_matches: results.length,
			hint: 'Too many results. Showing top 10 by layer priority (mart > dim > fct > stg). Refine with more keywords, AND logic, or a narrower type.',
			top_10: results.slice(0, maxResults).map(({ node, matchedFields, matchReason }) => ({
				name: node.name ?? '',
				description: node.description ?? '',
				matched_fields: matchedFields,
				match_reason: matchReason,
			})),
		};
		return fallbackMessage ? { ...output, logic_used: fallbackMessage } : output;
	}

	const slim = results.map(({ node, matchedColumns, matchedFields, matchReason }) =>
		slimNode(node, matchedColumns.length > 0 ? matchedColumns : undefined, includeSql, {
			fields: matchedFields,
			reason: matchReason,
		}),
	);
	return fallbackMessage ? { logic_used: fallbackMessage, results: slim } : slim;
}

function baseNode(node: ManifestNode): Pick<SlimManifestNode, 'name' | 'description' | 'relation_name' | 'path'> {
	const database = node.database ?? '';
	const schema = node.schema ?? '';
	const alias = node.alias || node.name || '';
	const relationName = database ? `${database}.${schema}.${alias}` : alias;
	return {
		name: node.name ?? '',
		description: node.description ?? '',
		relation_name: relationName,
		path: node.original_file_path ?? '',
	};
}

function findModelEntry(
	nodes: Record<string, ManifestNode>,
	modelName: string,
): [string, ManifestNode] | undefined {
	return Object.entries(nodes).find(([, node]) => isModel(node) && node.name === modelName);
}

function modelNamesForKeys(nodes: Record<string, ManifestNode>, keys: string[]): string[] {
	return keys
		.map((key) => nodes[key])
		.filter((node): node is ManifestNode => node !== undefined && isModel(node))
		.map((node) => node.name ?? '')
		.filter(Boolean)
		.sort((a, b) => a.localeCompare(b));
}

function layerRank(name: string, ranks: Record<string, number>): number {
	for (const [prefix, rank] of Object.entries(ranks)) {
		if (name === prefix || name.startsWith(`${prefix}_`)) return rank;
	}
	return 99;
}
