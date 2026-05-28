import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { Type, type ToolDef } from '@flue/runtime';

import { actorKey, conversationKey, runKey, safeFileName, safePathPart } from '../lib/persistence/namespaces.ts';
import type { ToolPolicy } from './policy.ts';

type LocalScopeName = 'scratch' | 'reports' | 'outputs' | 'context_drafts' | 'skills';
type SyncTarget = 'none' | 'gcs' | 'firestore';

interface LocalScope {
	name: LocalScopeName;
	description: string;
	dir: string;
	writable: boolean;
	sync: SyncTarget;
	target?: string;
	maxBytes: number;
	contentTypes?: Record<string, string>;
}

interface LocalManifestFile {
	scope: LocalScopeName;
	path: string;
	absolutePath: string;
	bytes: number;
	contentType: string;
	sync: SyncTarget;
	target?: string;
	title?: string;
	metadata?: Record<string, unknown>;
	updatedAt: string;
}

interface LocalManifest {
	version: 1;
	conversationId: string;
	runId: string;
	root: string;
	files: LocalManifestFile[];
}

export function createLocalWorkspaceTools(policy: ToolPolicy): ToolDef[] {
	const config = localWorkspaceConfig(policy);

	const listTool: ToolDef = {
		name: 'local_list',
		description: 'List files in a bounded local run-workspace scope. Local files are drafts until uploaded or synced.',
		parameters: Type.Object({
			scope: scopeParam(),
			path: Type.Optional(Type.String({ description: 'Optional directory path within the scope.' })),
			maxEntries: Type.Optional(Type.Number({ description: 'Maximum entries to return. Defaults to 100.' })),
		}),
		execute: async (args) => {
			const scope = getScope(config.scopes, args.scope);
			const dirPath = resolveInScope(scope, optionalString(args.path, 'path') || '');
			const maxEntries = boundedInteger(args.maxEntries, 'maxEntries', 1, 1000, 100);
			const entries = await listEntries(scope, dirPath, maxEntries);
			return json({
				root: config.root,
				scope: scope.name,
				path: relativeToScope(scope, dirPath),
				entries,
				truncated: entries.length >= maxEntries,
			});
		},
	};

	const readTool: ToolDef = {
		name: 'local_read',
		description: 'Read a bounded preview of a local workspace file.',
		parameters: Type.Object({
			scope: scopeParam(),
			path: Type.String({ description: 'File path within the selected scope.' }),
			maxBytes: Type.Optional(Type.Number({ description: 'Maximum bytes to return. Defaults to 100000.' })),
		}),
		execute: async (args) => {
			const scope = getScope(config.scopes, args.scope);
			const filePath = resolveInScope(scope, asString(args.path, 'path'));
			const maxBytes = boundedInteger(args.maxBytes, 'maxBytes', 1, 1_000_000, 100_000);
			const raw = await fs.readFile(filePath, 'utf8');
			const bytes = Buffer.byteLength(raw, 'utf8');
			return json({
				scope: scope.name,
				path: relativeToScope(scope, filePath),
				absolutePath: filePath,
				bytes,
				truncated: bytes > maxBytes,
				content: raw.slice(0, maxBytes),
			});
		},
	};

	const writeTool: ToolDef = {
		name: 'local_write',
		description:
			'Write or replace a local run-workspace file and register it in the local manifest. Durable sync is a separate step.',
		parameters: Type.Object({
			scope: scopeParam(),
			path: Type.String({ description: 'File path within the selected scope.' }),
			content: Type.String({ description: 'File content.' }),
			contentType: Type.Optional(Type.String({ description: 'MIME type. Defaults from file extension.' })),
			title: Type.Optional(Type.String({ description: 'Optional human-readable title for post-run sync.' })),
			metadataJson: Type.Optional(Type.String({ description: 'Optional JSON object metadata for post-run sync.' })),
		}),
		execute: async (args) => {
			const scope = getScope(config.scopes, args.scope);
			if (!scope.writable) throw new Error(`Local scope ${scope.name} is read-only.`);
			const filePath = resolveInScope(scope, asString(args.path, 'path'));
			const content = boundedString(args.content, 'content', 0, scope.maxBytes);
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, content, 'utf8');
			const entry = await upsertManifestFile(config, scope, filePath, {
				contentType: optionalString(args.contentType, 'contentType') || contentTypeForName(filePath),
				title: optionalString(args.title, 'title'),
				metadata: args.metadataJson === undefined ? undefined : jsonObject(args.metadataJson, 'metadataJson'),
			});
			return json({ ok: true, ...entry });
		},
	};

	const editTool: ToolDef = {
		name: 'local_edit',
		description: 'Edit a local workspace file with exact string replacement. Use local_read first for inspection.',
		parameters: Type.Object({
			scope: scopeParam(),
			path: Type.String({ description: 'File path within the selected scope.' }),
			find: Type.String({ description: 'Exact text to replace. Must occur exactly once unless replaceAll=true.' }),
			replace: Type.String({ description: 'Replacement text.' }),
			replaceAll: Type.Optional(Type.Boolean({ description: 'Replace every occurrence. Defaults to false.' })),
		}),
		execute: async (args) => {
			const scope = getScope(config.scopes, args.scope);
			if (!scope.writable) throw new Error(`Local scope ${scope.name} is read-only.`);
			const filePath = resolveInScope(scope, asString(args.path, 'path'));
			const find = asString(args.find, 'find');
			const replace = boundedString(args.replace, 'replace', 0, scope.maxBytes);
			const raw = await fs.readFile(filePath, 'utf8');
			const occurrences = raw.split(find).length - 1;
			if (occurrences === 0) throw new Error('The find text was not found.');
			if (!args.replaceAll && occurrences !== 1) {
				throw new Error(`The find text occurs ${occurrences} times. Set replaceAll=true or choose a narrower find string.`);
			}
			const updated = args.replaceAll ? raw.split(find).join(replace) : raw.replace(find, replace);
			if (Buffer.byteLength(updated, 'utf8') > scope.maxBytes) throw new Error(`Edited file exceeds ${scope.maxBytes} bytes.`);
			await fs.writeFile(filePath, updated, 'utf8');
			const entry = await upsertManifestFile(config, scope, filePath, {});
			return json({ ok: true, replacements: args.replaceAll ? occurrences : 1, ...entry });
		},
	};

	const statTool: ToolDef = {
		name: 'local_stat',
		description: 'Read metadata for a local workspace file and its planned sync target.',
		parameters: Type.Object({
			scope: scopeParam(),
			path: Type.String({ description: 'File path within the selected scope.' }),
		}),
		execute: async (args) => {
			const scope = getScope(config.scopes, args.scope);
			const filePath = resolveInScope(scope, asString(args.path, 'path'));
			const stat = await fs.stat(filePath);
			const manifest = await readManifest(config);
			const relPath = relativeToScope(scope, filePath);
			const manifestEntry = manifest.files.find((file) => file.scope === scope.name && file.path === relPath);
			return json({
				scope: scope.name,
				path: relPath,
				absolutePath: filePath,
				bytes: stat.size,
				mtime: stat.mtime.toISOString(),
				sync: scope.sync,
				target: scope.target,
				manifestEntry,
			});
		},
	};

	const manifestTool: ToolDef = {
		name: 'local_manifest',
		description: 'Read the local workspace manifest that post-run sync can use to promote files durably.',
		parameters: Type.Object({}),
		execute: async () => json(await readManifest(config)),
	};

	return [listTool, readTool, writeTool, editTool, statTool, manifestTool];
}

function localWorkspaceConfig(policy: ToolPolicy): {
	root: string;
	conversationId: string;
	runId: string;
	scopes: Record<LocalScopeName, LocalScope>;
} {
	const actor = policy.actor?.userId || policy.actor?.email || 'default';
	const actorDocKey = actorKey(policy.actor?.userId || policy.actor?.email ? policy.actor : { userId: actor });
	const conversationId = conversationKey(policy.conversationId || policy.actor?.userId || policy.actor?.email || 'default');
	const runId = runKey(policy.runId || 'default');
	const baseRoot =
		process.env.FLUE_LOCAL_WORKSPACE_DIR ||
		process.env.FLUE_RUN_WORKSPACE_DIR ||
		process.env.OUTPUT_DIR ||
		path.join(os.tmpdir(), 'flue-analytics-runs');
	const root = path.resolve(baseRoot, conversationKey(actor), runId);
	const scopes: Record<LocalScopeName, LocalScope> = {
		scratch: {
			name: 'scratch',
			description: 'Temporary notes and drafts. Not synced by default.',
			dir: path.join(root, 'scratch'),
			writable: true,
			sync: 'none',
			maxBytes: 10_000_000,
		},
		reports: {
			name: 'reports',
			description: 'Report drafts intended for report-files GCS sync.',
			dir: path.join(root, 'reports'),
			writable: true,
			sync: 'gcs',
			target: 'report-files/generated',
			maxBytes: 20_000_000,
		},
		outputs: {
			name: 'outputs',
			description: 'Generated query/output artifacts intended for conversation-scoped GCS sync.',
			dir: path.join(root, 'outputs'),
			writable: true,
			sync: 'gcs',
			target: path.posix.join('dbt-explorer', conversationId, 'outputs'),
			maxBytes: 20_000_000,
		},
		context_drafts: {
			name: 'context_drafts',
			description: 'Schema-validated user/project context drafts. Promotion to Firestore must be explicit.',
			dir: path.join(root, 'context-drafts'),
			writable: true,
			sync: 'firestore',
			target: `users/${actorDocKey}/context_proposals`,
			maxBytes: 1_000_000,
		},
		skills: {
			name: 'skills',
			description: 'Schema-validated personal skill drafts. Promotion to Firestore must be explicit.',
			dir: path.join(root, 'skills'),
			writable: true,
			sync: 'firestore',
			target: `users/${actorDocKey}/skills`,
			maxBytes: 1_000_000,
		},
	};
	return { root, conversationId, runId, scopes };
}

function scopeParam() {
	return Type.String({
		description: 'One of scratch, reports, outputs, context_drafts, or skills.',
	});
}

function getScope(scopes: Record<LocalScopeName, LocalScope>, value: unknown): LocalScope {
	const scope = asString(value, 'scope') as LocalScopeName;
	if (!Object.prototype.hasOwnProperty.call(scopes, scope)) {
		throw new Error('scope must be one of scratch, reports, outputs, context_drafts, or skills.');
	}
	return scopes[scope];
}

function resolveInScope(scope: LocalScope, unsafePath: string): string {
	const normalized = unsafePath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
	if (!normalized) return scope.dir;
	if (normalized.split('/').some((part) => part === '..')) throw new Error('Local workspace paths cannot contain ..');
	const parts = normalized.split('/').filter(Boolean);
	const safeParts = parts.map((part, index) => index === parts.length - 1 ? safeFileName(part) : safePathPart(part));
	const resolved = path.resolve(scope.dir, ...safeParts);
	if (resolved !== scope.dir && !resolved.startsWith(`${scope.dir}${path.sep}`)) {
		throw new Error(`Local workspace path must stay under ${scope.dir}.`);
	}
	return resolved;
}

function relativeToScope(scope: LocalScope, filePath: string): string {
	const relative = path.relative(scope.dir, filePath).replace(/\\/g, '/');
	return relative === '' ? '.' : relative;
}

async function listEntries(scope: LocalScope, dirPath: string, maxEntries: number) {
	const rawEntries = await fs.readdir(dirPath, { withFileTypes: true });
	const entries = [];
	for (const entry of rawEntries) {
		if (entries.length >= maxEntries) break;
		if (entry.name === '.flue-local-manifest.json') continue;
		const entryPath = path.join(dirPath, entry.name);
		const stat = await fs.stat(entryPath);
		entries.push({
			name: entry.name,
			path: relativeToScope(scope, entryPath),
			type: entry.isDirectory() ? 'directory' : 'file',
			bytes: entry.isDirectory() ? undefined : stat.size,
			mtime: stat.mtime.toISOString(),
		});
	}
	return entries;
}

async function upsertManifestFile(
	config: ReturnType<typeof localWorkspaceConfig>,
	scope: LocalScope,
	filePath: string,
	input: { contentType?: string; title?: string; metadata?: Record<string, unknown> },
): Promise<LocalManifestFile> {
	const stat = await fs.stat(filePath);
	const manifest = await readManifest(config);
	const relPath = relativeToScope(scope, filePath);
	const existing = manifest.files.find((file) => file.scope === scope.name && file.path === relPath);
	const entry: LocalManifestFile = {
		scope: scope.name,
		path: relPath,
		absolutePath: filePath,
		bytes: stat.size,
		contentType: input.contentType || existing?.contentType || contentTypeForName(filePath),
		sync: scope.sync,
		target: scope.target,
		title: input.title ?? existing?.title,
		metadata: input.metadata ?? existing?.metadata,
		updatedAt: new Date().toISOString(),
	};
	manifest.files = [
		...manifest.files.filter((file) => !(file.scope === scope.name && file.path === relPath)),
		entry,
	].sort((left, right) => `${left.scope}/${left.path}`.localeCompare(`${right.scope}/${right.path}`));
	await writeManifest(config, manifest);
	return entry;
}

async function readManifest(config: ReturnType<typeof localWorkspaceConfig>): Promise<LocalManifest> {
	const manifestPath = path.join(config.root, '.flue-local-manifest.json');
	try {
		const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as LocalManifest;
		return {
			version: 1,
			conversationId: parsed.conversationId || config.conversationId,
			runId: parsed.runId || config.runId,
			root: parsed.root || config.root,
			files: Array.isArray(parsed.files) ? parsed.files : [],
		};
	} catch (error: any) {
		if (error?.code !== 'ENOENT') throw error;
		return { version: 1, conversationId: config.conversationId, runId: config.runId, root: config.root, files: [] };
	}
}

async function writeManifest(config: ReturnType<typeof localWorkspaceConfig>, manifest: LocalManifest): Promise<void> {
	await fs.mkdir(config.root, { recursive: true });
	await fs.writeFile(path.join(config.root, '.flue-local-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

function asString(value: unknown, name: string): string {
	if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string.`);
	return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	return asString(value, name);
}

function boundedString(value: unknown, name: string, min: number, max: number): string {
	const text = min === 0 && value === '' ? '' : asString(value, name);
	if (text.length < min || Buffer.byteLength(text, 'utf8') > max) {
		throw new Error(`${name} must be between ${min} chars and ${max} bytes.`);
	}
	return text;
}

function boundedInteger(value: unknown, name: string, min: number, max: number, defaultValue: number): number {
	if (value === undefined || value === null) return defaultValue;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
		throw new Error(`${name} must be an integer between ${min} and ${max}.`);
	}
	return value;
}

function jsonObject(value: unknown, name: string): Record<string, unknown> {
	const parsed = JSON.parse(asString(value, name));
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${name} must be a JSON object.`);
	return parsed as Record<string, unknown>;
}

function contentTypeForName(name: string): string {
	if (name.endsWith('.html')) return 'text/html; charset=utf-8';
	if (name.endsWith('.md')) return 'text/markdown; charset=utf-8';
	if (name.endsWith('.ipynb')) return 'application/json; charset=utf-8';
	if (name.endsWith('.sql')) return 'text/sql; charset=utf-8';
	if (name.endsWith('.csv')) return 'text/csv; charset=utf-8';
	if (name.endsWith('.json')) return 'application/json; charset=utf-8';
	return 'text/plain; charset=utf-8';
}

function json(value: unknown): string {
	return JSON.stringify(value, null, 2);
}
