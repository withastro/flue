import * as path from 'node:path';

export const EVENUP_INTERNAL_TOOLS_PROJECT = 'evenup-internal-tools';
export const DBT_EXPLORER_NAMESPACE = 'dbt-explorer-api';
export const DEV_DBT_EXPLORER_NAMESPACE = 'dev-dbt-explorer-api';
export const PROD_DBT_EXPLORER_BUCKET = 'evenup-internal-tools-dbt-explorer-api';
export const DEV_DBT_EXPLORER_BUCKET = 'evenup-internal-tools-dev-dbt-explorer-api';
export const REPORT_DOC_BASE_URL = 'https://dbt-explorer-api.apps.evenup.law/reports/doc';

export interface PersistenceConfig {
	projectId?: string;
	firestoreDatabase: string;
	artifactBucket?: string;
	localRoot: string;
	publicArtifactBaseUrl?: string;
}

export function getPersistenceConfig(): PersistenceConfig {
	const firestoreDatabase =
		process.env.FIRESTORE_DATABASE ||
		process.env.DBT_EXPLORER_FIRESTORE_DATABASE ||
		DEV_DBT_EXPLORER_NAMESPACE;
	const artifactBucket =
		process.env.FLUE_ARTIFACT_BUCKET ||
		process.env.GCS_ARTIFACT_BUCKET ||
		process.env.GCS_BUCKET ||
		DEV_DBT_EXPLORER_BUCKET;
	return {
		projectId:
			process.env.FIRESTORE_PROJECT_ID ||
			process.env.GCP_PROJECT ||
			process.env.GOOGLE_CLOUD_PROJECT ||
			EVENUP_INTERNAL_TOOLS_PROJECT,
		firestoreDatabase,
		artifactBucket,
		localRoot: process.env.FLUE_LOCAL_PERSISTENCE_DIR || '/tmp/flue-analytics-persistence',
		publicArtifactBaseUrl: process.env.FLUE_ARTIFACT_PUBLIC_BASE_URL || REPORT_DOC_BASE_URL,
	};
}

export function actorKey(input: { userId?: string; email?: string }): string {
	const raw = input.userId || input.email;
	if (!raw) throw new Error('A userId or email is required for user-scoped persistence.');
	return safePathPart(raw.toLowerCase());
}

export function conversationKey(value?: string): string {
	return safePathPart(value || 'default');
}

export function runKey(value?: string): string {
	return safePathPart(value || String(Date.now()));
}

export function userContextCollection(user: string): string {
	return `users/${safePathPart(user)}`;
}

export function userContextDoc(user: string, key: string): string {
	void key;
	return userContextCollection(user);
}

export function projectContextCollection(projectId = 'default'): string {
	return `projects/${safePathPart(projectId)}/context`;
}

export function projectContextDoc(projectId: string, key: string): string {
	return `${projectContextCollection(projectId)}/${safePathPart(key)}`;
}

export function workflowStateDoc(workflowId: string): string {
	return `workflows/${safePathPart(workflowId)}`;
}

export function workflowEventCollection(workflowId: string): string {
	return `${workflowStateDoc(workflowId)}/events`;
}

export function workflowEventDoc(workflowId: string, eventId?: string): string {
	return `${workflowEventCollection(workflowId)}/${safePathPart(eventId || String(Date.now()))}`;
}

export function runTraceDoc(runId: string): string {
	return `runs/${safePathPart(runId)}`;
}

export function artifactObjectName(input: {
	conversationId?: string;
	runId?: string;
	kind?: string;
	name: string;
}): string {
	const safeName = safeFileName(input.name);
	return path.posix.join(
		'dbt-explorer',
		conversationKey(input.conversationId),
		safePathPart(input.kind || 'outputs'),
		safeName,
	);
}

export function reportObjectName(input: {
	reportType: string;
	date?: string;
	name: string;
}): string {
	const parts = ['report-files', safePathPart(input.reportType)];
	if (input.date) parts.push(safePathPart(input.date));
	parts.push(safeFileName(input.name));
	return path.posix.join(...parts);
}

export function safePathPart(value: string): string {
	const cleaned = value.trim().replace(/[^A-Za-z0-9_.:@-]+/g, '_').replace(/^_+|_+$/g, '');
	return cleaned.slice(0, 120) || 'default';
}

export function safeFileName(value: string): string {
	const base = path.posix.basename(value.trim()).replace(/[^A-Za-z0-9_.@ -]+/g, '_').trim();
	return base.slice(0, 160) || 'artifact.txt';
}
