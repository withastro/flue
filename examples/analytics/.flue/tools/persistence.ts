import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Type, type ToolDef } from '@flue/runtime';

import { artifactLink, readObjectMetadata, writeObject } from '../lib/persistence/gcs.ts';
import { listCollection, readDocument, writeDocument, appendDocument } from '../lib/persistence/firestore.ts';
import {
	actorKey,
	artifactObjectName,
	getPersistenceConfig,
	projectContextCollection,
	projectContextDoc,
	reportObjectName,
	runTraceDoc,
	userContextDoc,
	workflowEventCollection,
	workflowStateDoc,
} from '../lib/persistence/namespaces.ts';
import { createLocalWorkspaceTools } from './local.ts';
import type { ToolPolicy } from './policy.ts';

export function createContextPersistenceTools(policy: ToolPolicy): ToolDef[] {
	const readUserContextTool: ToolDef = {
		name: 'user_context_read',
		description:
			'Read the current user personal context entries. Use for durable preferences, terminology, and user-specific facts.',
		parameters: Type.Object({
			key: Type.Optional(Type.String({ description: 'Optional context key. Omit to list all entries.' })),
		}),
		execute: async (args) => {
			const user = actorKey(policy.actor ?? {});
			const key = optionalString(args.key, 'key');
			const doc = await readDocument(userContextDoc(user, key || 'preferences'));
			const preferences = preferenceMap(doc?.data?.preferences);
			if (key) {
				return json({
					path: userContextDoc(user, key),
					key,
					value: preferences[key],
					found: Object.prototype.hasOwnProperty.call(preferences, key),
				});
			}
			return json({
				path: userContextDoc(user, 'preferences'),
				preferences,
				updateTime: doc?.updateTime,
			});
		},
	};

	const upsertUserContextTool: ToolDef = {
		name: 'user_context_upsert',
		description:
			'Create or replace one current-user personal context entry. Disabled unless context writes are allowed.',
		parameters: Type.Object({
			key: Type.String({ description: 'Stable lowercase-ish slug for this context entry.' }),
			value: Type.String({ description: 'Atomic durable fact/rule/preference to remember. Do not store PHI.' }),
			summary: Type.Optional(Type.String({ description: 'Short human-readable summary of what changed.' })),
		}),
		execute: async (args) => {
			if (!policy.permissions.allowContextWrite) throw new Error('User context writes are disabled for this run.');
			const user = actorKey(policy.actor ?? {});
			const key = asString(args.key, 'key');
			const existing = await readDocument(userContextDoc(user, key));
			const preferences = {
				...preferenceMap(existing?.data?.preferences),
				[key]: boundedString(args.value, 'value', 1, 20_000),
			};
			const value = boundedString(args.value, 'value', 1, 20_000);
			return json(
				await writeDocument(userContextDoc(user, key), {
					...(existing?.data ?? {}),
					preferences,
					lastPreferenceUpdate: {
						key,
						value,
						summary: optionalString(args.summary, 'summary'),
					},
					summary: optionalString(args.summary, 'summary'),
					updatedBy: policy.actor?.email || policy.actor?.userId || 'unknown',
					source: policy.source,
				}),
			);
		},
	};

	const readProjectContextTool: ToolDef = {
		name: 'project_context_read',
		description:
			'Read versioned or shared project context entries. Use for durable project-level facts before proposing documentation changes.',
		parameters: Type.Object({
			projectId: Type.Optional(Type.String({ description: 'Project context namespace. Defaults to default.' })),
			key: Type.Optional(Type.String({ description: 'Optional context key. Omit to list all entries.' })),
		}),
		execute: async (args) => {
			const projectId = optionalString(args.projectId, 'projectId') || 'default';
			const key = optionalString(args.key, 'key');
			if (key) return json(await readDocument(projectContextDoc(projectId, key)));
			return json(await listCollection(projectContextCollection(projectId)));
		},
	};

	const proposeProjectContextTool: ToolDef = {
		name: 'project_context_propose_update',
		description:
			'Write a proposed project-context update for review. Does not directly edit versioned project docs.',
		parameters: Type.Object({
			projectId: Type.Optional(Type.String({ description: 'Project context namespace. Defaults to default.' })),
			key: Type.String({ description: 'Context key being proposed.' }),
			value: Type.String({ description: 'Proposed durable project fact/rule.' }),
			rationale: Type.String({ description: 'Why this should become shared project context.' }),
		}),
		execute: async (args) => {
			if (!policy.permissions.allowContextWrite) throw new Error('Context proposal writes are disabled for this run.');
			const projectId = optionalString(args.projectId, 'projectId') || 'default';
			const key = asString(args.key, 'key');
			return json(
				await appendDocument(`projects/${projectId}/context_proposals`, {
					key,
					value: boundedString(args.value, 'value', 1, 50_000),
					rationale: boundedString(args.rationale, 'rationale', 1, 10_000),
					createdBy: policy.actor?.email || policy.actor?.userId || 'unknown',
					source: policy.source,
					status: 'proposed',
				}),
			);
		},
	};

	const learnThisTool: ToolDef = {
		name: 'learnthis_save',
		description:
			'Save one durable fact/rule/preference to the current user preferences map. Use when the user explicitly asks you to remember something.',
		parameters: Type.Object({
			key: Type.String({ description: 'Stable lowercase-ish slug for this memory.' }),
			value: Type.String({ description: 'Atomic durable fact/rule/preference. Do not store PHI.' }),
			summary: Type.Optional(Type.String({ description: 'One-line summary to tell the user after saving.' })),
		}),
		execute: upsertUserContextTool.execute,
	};

	const listPersonalSkillsTool: ToolDef = {
		name: 'personal_skill_list',
		description: 'List current user personal skills from users/{email}/skills.',
		parameters: Type.Object({
			enabledOnly: Type.Optional(Type.Boolean({ description: 'Only return enabled skills. Defaults to false.' })),
		}),
		execute: async (args) => {
			const user = actorKey(policy.actor ?? {});
			const skills = await listCollection(`users/${user}/skills`);
			const filtered = args.enabledOnly ? skills.filter((skill) => skill.data.enabled === true) : skills;
			return json(filtered);
		},
	};

	const createPersonalSkillTool: ToolDef = {
		name: 'personal_skill_create',
		description:
			'Create a personal skill for the current user. Disabled unless context writes are allowed.',
		parameters: Type.Object({
			name: Type.String({ description: 'Skill display name, max 120 chars.' }),
			instruction: Type.String({ description: 'Skill instruction, max 4000 chars.' }),
			enabled: Type.Optional(Type.Boolean({ description: 'Whether the skill is enabled. Defaults to true.' })),
		}),
		execute: async (args) => {
			if (!policy.permissions.allowContextWrite) throw new Error('Personal skill writes are disabled for this run.');
			const user = actorKey(policy.actor ?? {});
			return json(
				await appendDocument(`users/${user}/skills`, {
					name: boundedString(args.name, 'name', 1, 120),
					instruction: boundedString(args.instruction, 'instruction', 1, 4000),
					enabled: args.enabled === undefined ? true : Boolean(args.enabled),
					createdBy: policy.actor?.email || policy.actor?.userId || 'unknown',
				}),
			);
		},
	};

	const updatePersonalSkillTool: ToolDef = {
		name: 'personal_skill_update',
		description:
			'Patch a current user personal skill by id. Disabled unless context writes are allowed.',
		parameters: Type.Object({
			skillId: Type.String({ description: 'Skill document id returned by personal_skill_list/create.' }),
			name: Type.Optional(Type.String({ description: 'New display name.' })),
			instruction: Type.Optional(Type.String({ description: 'New instruction.' })),
			enabled: Type.Optional(Type.Boolean({ description: 'Enable or disable this skill.' })),
		}),
		execute: async (args) => {
			if (!policy.permissions.allowContextWrite) throw new Error('Personal skill writes are disabled for this run.');
			const user = actorKey(policy.actor ?? {});
			const skillId = asString(args.skillId, 'skillId');
			const existing = await readDocument(`users/${user}/skills/${skillId}`);
			if (!existing) throw new Error(`Personal skill ${skillId} was not found.`);
			return json(
				await writeDocument(`users/${user}/skills/${skillId}`, {
					...existing.data,
					...(args.name === undefined ? {} : { name: boundedString(args.name, 'name', 1, 120) }),
					...(args.instruction === undefined
						? {}
						: { instruction: boundedString(args.instruction, 'instruction', 1, 4000) }),
					...(args.enabled === undefined ? {} : { enabled: Boolean(args.enabled) }),
					updatedBy: policy.actor?.email || policy.actor?.userId || 'unknown',
				}),
			);
		},
	};

	return [
		readUserContextTool,
		upsertUserContextTool,
		learnThisTool,
		readProjectContextTool,
		proposeProjectContextTool,
		listPersonalSkillsTool,
		createPersonalSkillTool,
		updatePersonalSkillTool,
	];
}

export function createArtifactPersistenceTools(policy: ToolPolicy): ToolDef[] {
	const localWriteTool: ToolDef = {
		name: 'report_local_write',
		description:
			'Write or replace a local report/artifact draft under the bounded report work directory before final upload.',
		parameters: Type.Object({
			name: Type.String({ description: 'File name, for example report.html, analysis.md, or query.sql.' }),
			content: Type.String({ description: 'File content.' }),
			subdir: Type.Optional(Type.String({ description: 'Optional subdirectory under the report work directory.' })),
		}),
		execute: async (args) => {
			const filePath = localReportPath({
				name: asString(args.name, 'name'),
				subdir: optionalString(args.subdir, 'subdir'),
			});
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			const content = boundedString(args.content, 'content', 0, 10_000_000);
			await fs.writeFile(filePath, content, 'utf8');
			return json({ ok: true, path: filePath, bytes: Buffer.byteLength(content, 'utf8') });
		},
	};

	const localReadTool: ToolDef = {
		name: 'report_local_read',
		description: 'Read a bounded preview of a local report/artifact draft before editing or upload.',
		parameters: Type.Object({
			path: Type.String({ description: 'Path returned by report_local_write.' }),
			maxBytes: Type.Optional(Type.Number({ description: 'Maximum bytes to return. Defaults to 100000.' })),
		}),
		execute: async (args) => {
			const filePath = assertLocalReportPath(asString(args.path, 'path'));
			const maxBytes = boundedInteger(args.maxBytes, 'maxBytes', 1, 1_000_000, 100_000);
			const raw = await fs.readFile(filePath, 'utf8');
			return json({
				path: filePath,
				bytes: Buffer.byteLength(raw, 'utf8'),
				truncated: Buffer.byteLength(raw, 'utf8') > maxBytes,
				content: raw.slice(0, maxBytes),
			});
		},
	};

	const localEditTool: ToolDef = {
		name: 'report_local_edit',
		description:
			'Edit a local report/artifact draft with exact string replacement. Use after report_local_read inspection.',
		parameters: Type.Object({
			path: Type.String({ description: 'Path returned by report_local_write.' }),
			find: Type.String({ description: 'Exact text to replace. Must occur exactly once unless replaceAll=true.' }),
			replace: Type.String({ description: 'Replacement text.' }),
			replaceAll: Type.Optional(Type.Boolean({ description: 'Replace every occurrence. Defaults to false.' })),
		}),
		execute: async (args) => {
			const filePath = assertLocalReportPath(asString(args.path, 'path'));
			const find = asString(args.find, 'find');
			const replace = boundedString(args.replace, 'replace', 0, 1_000_000);
			const raw = await fs.readFile(filePath, 'utf8');
			const occurrences = raw.split(find).length - 1;
			if (occurrences === 0) throw new Error('The find text was not found.');
			if (!args.replaceAll && occurrences !== 1) {
				throw new Error(`The find text occurs ${occurrences} times. Set replaceAll=true or choose a narrower find string.`);
			}
			const updated = args.replaceAll ? raw.split(find).join(replace) : raw.replace(find, replace);
			if (Buffer.byteLength(updated, 'utf8') > 10_000_000) throw new Error('Edited file exceeds 10 MB limit.');
			await fs.writeFile(filePath, updated, 'utf8');
			return json({ ok: true, path: filePath, replacements: args.replaceAll ? occurrences : 1 });
		},
	};

	const writeArtifactTool: ToolDef = {
		name: 'artifact_write',
		description:
			'Persist a generated text artifact to the configured artifact bucket/path. The tool generates the storage path.',
		parameters: Type.Object({
			name: Type.String({ description: 'File name, for example analysis.sql or report.html.' }),
			content: Type.String({ description: 'Artifact content.' }),
			contentType: Type.Optional(Type.String({ description: 'MIME type. Defaults to text/plain.' })),
			kind: Type.Optional(Type.String({ description: 'Artifact kind folder, for example sql, report, note, export.' })),
			conversationId: Type.Optional(Type.String({ description: 'Conversation id for namespacing. Defaults to user/session.' })),
			runId: Type.Optional(Type.String({ description: 'Run id for namespacing. Defaults to current timestamp.' })),
		}),
		execute: async (args) => {
			const object = artifactObjectName({
				conversationId: optionalString(args.conversationId, 'conversationId') ||
					policy.actor?.userId ||
					policy.actor?.email ||
					'default',
				runId: optionalString(args.runId, 'runId'),
				kind: optionalString(args.kind, 'kind'),
				name: asString(args.name, 'name'),
			});
			return json(
				await writeObject({
					object,
					content: boundedString(args.content, 'content', 0, 5_000_000),
					contentType: optionalString(args.contentType, 'contentType'),
				}),
			);
		},
	};

	const writeReportTool: ToolDef = {
		name: 'report_artifact_write',
		description:
			'Persist an HTML/report artifact under the reports namespace. Use for report workflows that need stable report URLs.',
		parameters: Type.Object({
			reportType: Type.String({ description: 'Report type folder, for example ai_playbooks or mdc.' }),
			name: Type.String({ description: 'Report file name, usually ending in .html.' }),
			content: Type.String({ description: 'Report content.' }),
			date: Type.Optional(Type.String({ description: 'Optional report date YYYY-MM-DD to insert as a path segment.' })),
			contentType: Type.Optional(Type.String({ description: 'MIME type. Defaults to text/html.' })),
		}),
		execute: async (args) => {
			const object = reportObjectName({
				reportType: asString(args.reportType, 'reportType'),
				date: optionalString(args.date, 'date'),
				name: asString(args.name, 'name'),
			});
			const result = await writeObject({
					object,
					content: boundedString(args.content, 'content', 0, 10_000_000),
					contentType: optionalString(args.contentType, 'contentType') || 'text/html',
			});
			if (policy.actor?.email) {
				await appendDocument(`users/${policy.actor.email}/reports`, {
					docPath: object.slice('report-files/'.length).replace(/\.[^/.]+$/, ''),
					title: asString(args.name, 'name').replace(/\.[^/.]+$/, ''),
					type: reportTypeFromName(asString(args.name, 'name')),
					folder: asString(args.reportType, 'reportType'),
					gcsPath: result.uri,
				});
			}
			return json(result);
		},
	};

	const uploadReportTool: ToolDef = {
		name: 'report_artifact_upload',
		description:
			'Upload a finalized local report/artifact draft to GCS report-files and record ownership when actor email is known.',
		parameters: Type.Object({
			path: Type.String({ description: 'Local path returned by report_local_write.' }),
			reportType: Type.Optional(Type.String({ description: 'Report folder. Defaults to generated.' })),
			name: Type.Optional(Type.String({ description: 'Destination file name. Defaults to local basename.' })),
			date: Type.Optional(Type.String({ description: 'Optional report date YYYY-MM-DD to insert as a path segment.' })),
			contentType: Type.Optional(Type.String({ description: 'MIME type. Defaults from file extension.' })),
		}),
		execute: async (args) => {
			const localPath = assertLocalReportPath(asString(args.path, 'path'));
			const name = optionalString(args.name, 'name') || path.basename(localPath);
			const object = reportObjectName({
				reportType: optionalString(args.reportType, 'reportType') || 'generated',
				date: optionalString(args.date, 'date'),
				name,
			});
			const content = await fs.readFile(localPath);
			if (content.byteLength > 20_000_000) throw new Error('Report upload exceeds 20 MB limit.');
			const result = await writeObject({
				object,
				content,
				contentType: optionalString(args.contentType, 'contentType') || contentTypeForName(name),
			});
			if (policy.actor?.email) {
				await appendDocument(`users/${policy.actor.email}/reports`, {
					docPath: object.slice('report-files/'.length).replace(/\.[^/.]+$/, ''),
					title: name.replace(/\.[^/.]+$/, ''),
					type: reportTypeFromName(name),
					folder: optionalString(args.reportType, 'reportType') || 'generated',
					gcsPath: result.uri,
				});
			}
			return json(result);
		},
	};

	const metadataTool: ToolDef = {
		name: 'artifact_read_metadata',
		description: 'Read metadata for a persisted artifact by object path.',
		parameters: Type.Object({
			object: Type.String({ description: 'Object path returned by artifact_write or report_artifact_write.' }),
		}),
		execute: async (args) => json(await readObjectMetadata({ object: asString(args.object, 'object') })),
	};

	const linkTool: ToolDef = {
		name: 'artifact_get_link',
		description:
			'Get the configured public/report link or gs:// URI for a persisted artifact. Does not create a signed URL unless a public base URL is configured.',
		parameters: Type.Object({
			object: Type.String({ description: 'Object path returned by artifact_write or report_artifact_write.' }),
		}),
		execute: async (args) => json(artifactLink({ object: asString(args.object, 'object') }, getPersistenceConfig())),
	};

	return [
		...createLocalWorkspaceTools(policy),
		localWriteTool,
		localReadTool,
		localEditTool,
		writeArtifactTool,
		writeReportTool,
		uploadReportTool,
		metadataTool,
		linkTool,
	];
}

export function createWorkflowPersistenceTools(policy: ToolPolicy): ToolDef[] {
	const getWorkflowTool: ToolDef = {
		name: 'workflow_state_get',
		description: 'Read durable state for a workflow id.',
		parameters: Type.Object({
			workflowId: Type.String({ description: 'Workflow id.' }),
		}),
		execute: async (args) => json(await readDocument(workflowStateDoc(asString(args.workflowId, 'workflowId')))),
	};

	const putWorkflowTool: ToolDef = {
		name: 'workflow_state_put',
		description: 'Create or replace durable workflow state. Disabled unless workflow mutation is allowed.',
		parameters: Type.Object({
			workflowId: Type.String({ description: 'Workflow id.' }),
			stateJson: Type.String({ description: 'Workflow state as a JSON object string.' }),
			status: Type.Optional(Type.String({ description: 'Optional status label.' })),
		}),
		execute: async (args) => {
			if (!policy.permissions.allowWorkflowMutation) throw new Error('Workflow state mutation is disabled for this run.');
			return json(
				await writeDocument(workflowStateDoc(asString(args.workflowId, 'workflowId')), {
					state: jsonObject(args.stateJson, 'stateJson'),
					status: optionalString(args.status, 'status'),
					updatedBy: policy.actor?.email || policy.actor?.userId || 'unknown',
				}),
			);
		},
	};

	const appendWorkflowEventTool: ToolDef = {
		name: 'workflow_state_append_event',
		description: 'Append an event to durable workflow state. Disabled unless workflow mutation is allowed.',
		parameters: Type.Object({
			workflowId: Type.String({ description: 'Workflow id.' }),
			eventType: Type.String({ description: 'Event type.' }),
			payloadJson: Type.Optional(Type.String({ description: 'Event payload as a JSON object string.' })),
		}),
		execute: async (args) => {
			if (!policy.permissions.allowWorkflowMutation) throw new Error('Workflow state mutation is disabled for this run.');
			return json(
				await appendDocument(workflowEventCollection(asString(args.workflowId, 'workflowId')), {
					eventType: asString(args.eventType, 'eventType'),
					payload: args.payloadJson === undefined ? {} : jsonObject(args.payloadJson, 'payloadJson'),
					createdBy: policy.actor?.email || policy.actor?.userId || 'unknown',
					source: policy.source,
				}),
			);
		},
	};

	return [getWorkflowTool, putWorkflowTool, appendWorkflowEventTool];
}

export function createTracePersistenceTools(): ToolDef[] {
	const traceGetTool: ToolDef = {
		name: 'trace_get',
		description: 'Read stored run trace metadata for a run id, when available.',
		parameters: Type.Object({
			runId: Type.String({ description: 'Flue run id.' }),
		}),
		execute: async (args) => json(await readDocument(runTraceDoc(asString(args.runId, 'runId')))),
	};

	return [traceGetTool];
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
	if (text.length < min || text.length > max) throw new Error(`${name} must be between ${min} and ${max} chars.`);
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
	const text = asString(value, name);
	const parsed = JSON.parse(text);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${name} must be a JSON object.`);
	return parsed as Record<string, unknown>;
}

function preferenceMap(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function reportTypeFromName(name: string): string {
	if (name.endsWith('.ipynb')) return 'notebook';
	if (name.endsWith('.md')) return 'md';
	if (name.endsWith('.html')) return 'html';
	return 'file';
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

function localReportRoot(): string {
	return process.env.FLUE_REPORT_WORK_DIR || process.env.OUTPUT_DIR || '/tmp/flue-analytics-reports';
}

function localReportPath(input: { name: string; subdir?: string }): string {
	const root = path.resolve(localReportRoot());
	const subdir = input.subdir ? safeLocalPart(input.subdir) : '';
	const filePath = path.resolve(root, subdir, safeLocalPart(path.basename(input.name)));
	return assertLocalReportPath(filePath);
}

function assertLocalReportPath(filePath: string): string {
	const root = path.resolve(localReportRoot());
	const resolved = path.resolve(filePath);
	if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
		throw new Error(`Local report path must be under ${root}.`);
	}
	return resolved;
}

function safeLocalPart(value: string): string {
	const cleaned = value.trim().replace(/[^A-Za-z0-9_.@/-]+/g, '_').replace(/^\/+/, '');
	if (!cleaned || cleaned.includes('..')) throw new Error('Invalid local report path segment.');
	return cleaned;
}

function json(value: unknown): string {
	return JSON.stringify(value, null, 2);
}
