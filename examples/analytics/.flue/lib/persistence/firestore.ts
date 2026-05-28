import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { GoogleAuth } from 'google-auth-library';

import { getPersistenceConfig, type PersistenceConfig } from './namespaces.ts';

const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';

export interface FirestoreRecord {
	path: string;
	data: Record<string, unknown>;
	updateTime?: string;
	createTime?: string;
}

export async function readDocument(
	docPath: string,
	config: PersistenceConfig = getPersistenceConfig(),
): Promise<FirestoreRecord | undefined> {
	if (!shouldUseFirestore(config)) return readLocalDocument(docPath, config);
	const response = await firestoreFetch(config, docPath, { method: 'GET' });
	if (response.status === 404) return undefined;
	await assertOk(response, `read Firestore document ${docPath}`);
	const data = await response.json() as any;
	return firestoreRecord(docPath, data);
}

export async function listCollection(
	collectionPath: string,
	config: PersistenceConfig = getPersistenceConfig(),
): Promise<FirestoreRecord[]> {
	if (!shouldUseFirestore(config)) return listLocalCollection(collectionPath, config);
	const response = await firestoreFetch(config, collectionPath, { method: 'GET' });
	if (response.status === 404) return [];
	await assertOk(response, `list Firestore collection ${collectionPath}`);
	const data = await response.json() as any;
	return (Array.isArray(data.documents) ? data.documents : []).map((doc: any) =>
		firestoreRecord(nameToDocPath(doc.name), doc),
	);
}

export async function writeDocument(
	docPath: string,
	data: Record<string, unknown>,
	config: PersistenceConfig = getPersistenceConfig(),
): Promise<FirestoreRecord> {
	const stored = {
		...data,
		updatedAt: new Date().toISOString(),
	};
	if (!shouldUseFirestore(config)) return writeLocalDocument(docPath, stored, config);
	const response = await firestoreFetch(config, docPath, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ fields: toFirestoreFields(stored) }),
	});
	await assertOk(response, `write Firestore document ${docPath}`);
	const result = await response.json() as any;
	return firestoreRecord(docPath, result);
}

export async function appendDocument(
	collectionPath: string,
	data: Record<string, unknown>,
	config: PersistenceConfig = getPersistenceConfig(),
): Promise<FirestoreRecord> {
	const id = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
	return writeDocument(`${collectionPath}/${id}`, data, config);
}

function shouldUseFirestore(config: PersistenceConfig): boolean {
	return Boolean(config.projectId && process.env.FLUE_PERSISTENCE_MODE !== 'local');
}

async function firestoreFetch(config: PersistenceConfig, docPath: string, init: RequestInit): Promise<Response> {
	if (!config.projectId) throw new Error('Firestore project is not configured.');
	const token = await getAccessToken();
	const url = new URL(
		`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/databases/${encodeURIComponent(config.firestoreDatabase)}/documents/${encodeFirestorePath(docPath)}`,
	);
	return fetch(url, {
		...init,
		headers: {
			authorization: `Bearer ${token}`,
			...(init.headers ?? {}),
		},
	});
}

async function getAccessToken(): Promise<string> {
	const auth = new GoogleAuth({ scopes: [FIRESTORE_SCOPE] });
	const token = await auth.getAccessToken();
	if (!token) throw new Error('Could not obtain Google auth token for Firestore.');
	return token;
}

async function assertOk(response: Response, action: string) {
	if (response.ok) return;
	const text = await response.text();
	throw new Error(`Failed to ${action}: ${response.status} ${text.slice(0, 1000)}`);
}

function firestoreRecord(docPath: string, raw: any): FirestoreRecord {
	return {
		path: docPath,
		data: fromFirestoreFields(raw.fields ?? {}),
		createTime: raw.createTime,
		updateTime: raw.updateTime,
	};
}

function nameToDocPath(name: string): string {
	const marker = '/documents/';
	const index = name.indexOf(marker);
	return index >= 0 ? name.slice(index + marker.length) : name;
}

function encodeFirestorePath(docPath: string): string {
	return docPath.split('/').map(encodeURIComponent).join('/');
}

function toFirestoreFields(data: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, toFirestoreValue(value)]));
}

function toFirestoreValue(value: unknown): Record<string, unknown> {
	if (value === null || value === undefined) return { nullValue: null };
	if (typeof value === 'string') return { stringValue: value };
	if (typeof value === 'boolean') return { booleanValue: value };
	if (typeof value === 'number') {
		return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
	}
	if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue) } };
	if (typeof value === 'object') return { mapValue: { fields: toFirestoreFields(value as Record<string, unknown>) } };
	return { stringValue: String(value) };
}

function fromFirestoreFields(fields: Record<string, any>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, fromFirestoreValue(value)]));
}

function fromFirestoreValue(value: any): unknown {
	if ('stringValue' in value) return value.stringValue;
	if ('booleanValue' in value) return value.booleanValue;
	if ('integerValue' in value) return Number(value.integerValue);
	if ('doubleValue' in value) return Number(value.doubleValue);
	if ('timestampValue' in value) return value.timestampValue;
	if ('nullValue' in value) return null;
	if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(fromFirestoreValue);
	if ('mapValue' in value) return fromFirestoreFields(value.mapValue.fields ?? {});
	return undefined;
}

async function readLocalDocument(
	docPath: string,
	config: PersistenceConfig,
): Promise<FirestoreRecord | undefined> {
	const filePath = localDocPath(config, docPath);
	try {
		const raw = await fs.readFile(filePath, 'utf8');
		const parsed = JSON.parse(raw);
		return { path: docPath, data: parsed.data ?? {}, updateTime: parsed.updateTime, createTime: parsed.createTime };
	} catch (error: any) {
		if (error?.code === 'ENOENT') return undefined;
		throw error;
	}
}

async function listLocalCollection(collectionPath: string, config: PersistenceConfig): Promise<FirestoreRecord[]> {
	const dir = localCollectionPath(config, collectionPath);
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		const docs = await Promise.all(
			entries
				.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
				.map((entry) => readLocalDocument(`${collectionPath}/${entry.name.slice(0, -5)}`, config)),
		);
		return docs.filter((doc): doc is FirestoreRecord => Boolean(doc));
	} catch (error: any) {
		if (error?.code === 'ENOENT') return [];
		throw error;
	}
}

async function writeLocalDocument(
	docPath: string,
	data: Record<string, unknown>,
	config: PersistenceConfig,
): Promise<FirestoreRecord> {
	const filePath = localDocPath(config, docPath);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const previous = await readLocalDocument(docPath, config);
	const createTime = previous?.createTime ?? new Date().toISOString();
	const updateTime = new Date().toISOString();
	await fs.writeFile(filePath, JSON.stringify({ createTime, updateTime, data }, null, 2));
	return { path: docPath, data, createTime, updateTime };
}

function localDocPath(config: PersistenceConfig, docPath: string): string {
	return path.join(config.localRoot, 'firestore', `${docPath}.json`);
}

function localCollectionPath(config: PersistenceConfig, collectionPath: string): string {
	return path.join(config.localRoot, 'firestore', collectionPath);
}
