import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { GoogleAuth } from 'google-auth-library';

import type { SessionData, SessionStore } from '../types.ts';

const GCS_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';
const DEFAULT_LOCAL_DIR = '/tmp/flue-sessions';
const DEFAULT_PREFIX = 'flue/sessions';

type FetchLike = typeof fetch;

export interface LocalGcsSessionStoreOptions {
	localDir?: string;
	bucket?: string;
	prefix?: string;
	fetchImpl?: FetchLike;
	getAccessToken?: () => Promise<string>;
}

export class LocalGcsSessionStore implements SessionStore {
	private readonly localDir: string;
	private readonly bucket?: string;
	private readonly prefix: string;
	private readonly fetcher: FetchLike;
	private readonly getToken: () => Promise<string>;

	constructor(options: LocalGcsSessionStoreOptions = {}) {
		this.localDir = options.localDir || DEFAULT_LOCAL_DIR;
		this.bucket = options.bucket;
		this.prefix = cleanPrefix(options.prefix || DEFAULT_PREFIX);
		this.fetcher = options.fetchImpl || fetch;
		this.getToken = options.getAccessToken || getGoogleAccessToken;
	}

	async save(id: string, data: SessionData): Promise<void> {
		const payload = encodeSessionFile(id, data);
		const bytes = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
		await this.writeLocal(id, bytes);
		if (!this.bucket) return;
		await this.writeGcs(this.objectName(id), bytes);
	}

	async load(id: string): Promise<SessionData | null> {
		const local = await this.readLocal(id);
		if (local) return local;
		if (!this.bucket) return null;
		const remote = await this.readGcs(this.objectName(id));
		if (!remote) return null;
		await this.writeLocal(id, Buffer.from(JSON.stringify(encodeSessionFile(id, remote), null, 2), 'utf8'));
		return remote;
	}

	async delete(id: string): Promise<void> {
		await fs.rm(this.localPath(id), { force: true });
		if (!this.bucket) return;
		await this.deleteGcs(this.objectName(id));
	}

	objectName(id: string): string {
		return `${this.prefix}/${encodeStorageKey(id)}.json`;
	}

	localPath(id: string): string {
		return path.join(this.localDir, `${encodeStorageKey(id)}.json`);
	}

	private async writeLocal(id: string, bytes: Buffer): Promise<void> {
		const filePath = this.localPath(id);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, bytes);
	}

	private async readLocal(id: string): Promise<SessionData | null> {
		try {
			return decodeSessionFile(await fs.readFile(this.localPath(id), 'utf8'));
		} catch (error: any) {
			if (error?.code === 'ENOENT') return null;
			throw error;
		}
	}

	private async writeGcs(object: string, bytes: Buffer): Promise<void> {
		const token = await this.getToken();
		const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.requireBucket())}/o`);
		url.searchParams.set('uploadType', 'media');
		url.searchParams.set('name', object);
		const response = await this.fetcher(url, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json; charset=utf-8',
			},
			body: bytes,
		});
		await assertOk(response, `write GCS session ${object}`);
	}

	private async readGcs(object: string): Promise<SessionData | null> {
		const token = await this.getToken();
		const url = new URL(
			`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.requireBucket())}/o/${encodeURIComponent(object)}?alt=media`,
		);
		const response = await this.fetcher(url, {
			method: 'GET',
			headers: { authorization: `Bearer ${token}` },
		});
		if (response.status === 404) return null;
		await assertOk(response, `read GCS session ${object}`);
		return decodeSessionFile(await response.text());
	}

	private async deleteGcs(object: string): Promise<void> {
		const token = await this.getToken();
		const url = new URL(
			`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.requireBucket())}/o/${encodeURIComponent(object)}`,
		);
		const response = await this.fetcher(url, {
			method: 'DELETE',
			headers: { authorization: `Bearer ${token}` },
		});
		if (response.status === 404) return;
		await assertOk(response, `delete GCS session ${object}`);
	}

	private requireBucket(): string {
		if (!this.bucket) throw new Error('A GCS bucket is required for remote Flue session persistence.');
		return this.bucket;
	}
}

export function createNodeSessionStoreFromEnv(): SessionStore {
	const mode = process.env.FLUE_SESSION_STORE;
	if (mode !== 'gcs') {
		throw new Error(`Unsupported FLUE_SESSION_STORE value: ${mode}`);
	}
	const bucket = process.env.FLUE_SESSION_BUCKET || process.env.GCS_BUCKET;
	if (!bucket) {
		throw new Error('FLUE_SESSION_STORE=gcs requires FLUE_SESSION_BUCKET or GCS_BUCKET.');
	}
	return new LocalGcsSessionStore({
		localDir: process.env.FLUE_SESSION_LOCAL_DIR || DEFAULT_LOCAL_DIR,
		bucket,
		prefix: process.env.FLUE_SESSION_GCS_PREFIX || DEFAULT_PREFIX,
	});
}

function encodeSessionFile(id: string, data: SessionData) {
	return {
		kind: 'flue.session',
		storageKey: id,
		session: data,
		updatedAt: new Date().toISOString(),
	};
}

function decodeSessionFile(raw: string): SessionData {
	const parsed = JSON.parse(raw);
	const data = parsed?.kind === 'flue.session' ? parsed.session : parsed;
	if (!data || data.version !== 3 || !Array.isArray(data.entries)) {
		throw new Error('Invalid Flue session data.');
	}
	return data as SessionData;
}

function encodeStorageKey(id: string): string {
	return Buffer.from(id, 'utf8').toString('base64url');
}

function cleanPrefix(prefix: string): string {
	return prefix.replace(/^\/+|\/+$/g, '') || DEFAULT_PREFIX;
}

async function getGoogleAccessToken(): Promise<string> {
	const auth = new GoogleAuth({ scopes: [GCS_SCOPE] });
	const token = await auth.getAccessToken();
	if (!token) throw new Error('Could not obtain Google auth token for GCS session persistence.');
	return token;
}

async function assertOk(response: Response, action: string): Promise<void> {
	if (response.ok) return;
	const text = await response.text().catch(() => '');
	throw new Error(`Failed to ${action}: ${response.status} ${text.slice(0, 1000)}`);
}
