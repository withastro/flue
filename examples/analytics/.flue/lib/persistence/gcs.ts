import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { GoogleAuth } from 'google-auth-library';

import { getPersistenceConfig, REPORT_DOC_BASE_URL, type PersistenceConfig } from './namespaces.ts';

const GCS_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';

export interface ArtifactWriteResult {
	ok: true;
	bucket: string;
	object: string;
	uri: string;
	sizeBytes: number;
	contentType: string;
	publicUrl?: string;
	localPath?: string;
}

export interface ArtifactMetadata {
	bucket: string;
	object: string;
	uri: string;
	sizeBytes?: number;
	contentType?: string;
	updated?: string;
	publicUrl?: string;
	localPath?: string;
}

export async function writeObject(
	input: {
		object: string;
		content: string | Uint8Array;
		contentType?: string;
		bucket?: string;
	},
	config: PersistenceConfig = getPersistenceConfig(),
): Promise<ArtifactWriteResult> {
	const bucket = input.bucket || config.artifactBucket || 'local-artifacts';
	const contentType = input.contentType || 'text/plain';
	const bytes = typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : Buffer.from(input.content);
	if (!shouldUseGcs(config, bucket)) {
		const localPath = localObjectPath(config, bucket, input.object);
		await fs.mkdir(path.dirname(localPath), { recursive: true });
		await fs.writeFile(localPath, bytes);
		await fs.writeFile(`${localPath}.metadata.json`, JSON.stringify({ contentType, sizeBytes: bytes.length }, null, 2));
		return {
			ok: true,
			bucket,
			object: input.object,
			uri: `gs://${bucket}/${input.object}`,
			sizeBytes: bytes.length,
			contentType,
			publicUrl: publicUrl(config, input.object),
			localPath,
		};
	}

	const token = await getAccessToken();
	const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`);
	url.searchParams.set('uploadType', 'media');
	url.searchParams.set('name', input.object);
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': contentType,
		},
		body: bytes,
	});
	await assertOk(response, `write GCS object ${bucket}/${input.object}`);
	const data = await response.json() as any;
	return {
		ok: true,
		bucket,
		object: data.name || input.object,
		uri: `gs://${bucket}/${data.name || input.object}`,
		sizeBytes: Number(data.size ?? bytes.length),
		contentType,
		publicUrl: publicUrl(config, data.name || input.object),
	};
}

export async function readObjectMetadata(
	input: { object: string; bucket?: string },
	config: PersistenceConfig = getPersistenceConfig(),
): Promise<ArtifactMetadata | undefined> {
	const bucket = input.bucket || config.artifactBucket || 'local-artifacts';
	if (!shouldUseGcs(config, bucket)) return readLocalMetadata(config, bucket, input.object);

	const token = await getAccessToken();
	const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(input.object)}`);
	const response = await fetch(url, {
		method: 'GET',
		headers: { authorization: `Bearer ${token}` },
	});
	if (response.status === 404) return undefined;
	await assertOk(response, `read GCS metadata ${bucket}/${input.object}`);
	const data = await response.json() as any;
	return {
		bucket,
		object: data.name || input.object,
		uri: `gs://${bucket}/${data.name || input.object}`,
		sizeBytes: data.size === undefined ? undefined : Number(data.size),
		contentType: data.contentType,
		updated: data.updated,
		publicUrl: publicUrl(config, data.name || input.object),
	};
}

export function artifactLink(
	input: { object: string; bucket?: string },
	config: PersistenceConfig = getPersistenceConfig(),
): ArtifactMetadata {
	const bucket = input.bucket || config.artifactBucket || 'local-artifacts';
	return {
		bucket,
		object: input.object,
		uri: `gs://${bucket}/${input.object}`,
		publicUrl: publicUrl(config, input.object),
		localPath: shouldUseGcs(config, bucket) ? undefined : localObjectPath(config, bucket, input.object),
	};
}

function shouldUseGcs(config: PersistenceConfig, bucket: string): boolean {
	return Boolean(config.projectId && config.artifactBucket && bucket !== 'local-artifacts' && process.env.FLUE_PERSISTENCE_MODE !== 'local');
}

async function getAccessToken(): Promise<string> {
	const auth = new GoogleAuth({ scopes: [GCS_SCOPE] });
	const token = await auth.getAccessToken();
	if (!token) throw new Error('Could not obtain Google auth token for GCS.');
	return token;
}

async function assertOk(response: Response, action: string) {
	if (response.ok) return;
	const text = await response.text();
	throw new Error(`Failed to ${action}: ${response.status} ${text.slice(0, 1000)}`);
}

async function readLocalMetadata(
	config: PersistenceConfig,
	bucket: string,
	object: string,
): Promise<ArtifactMetadata | undefined> {
	const localPath = localObjectPath(config, bucket, object);
	try {
		const stat = await fs.stat(localPath);
		let sidecar: any = {};
		try {
			sidecar = JSON.parse(await fs.readFile(`${localPath}.metadata.json`, 'utf8'));
		} catch {}
		return {
			bucket,
			object,
			uri: `gs://${bucket}/${object}`,
			sizeBytes: sidecar.sizeBytes ?? stat.size,
			contentType: sidecar.contentType,
			updated: stat.mtime.toISOString(),
			publicUrl: publicUrl(config, object),
			localPath,
		};
	} catch (error: any) {
		if (error?.code === 'ENOENT') return undefined;
		throw error;
	}
}

function localObjectPath(config: PersistenceConfig, bucket: string, object: string): string {
	return path.join(config.localRoot, 'gcs', bucket, object);
}

function publicUrl(config: PersistenceConfig, object: string): string | undefined {
	if (!config.publicArtifactBaseUrl) return undefined;
	if (object.startsWith('report-files/') && config.publicArtifactBaseUrl === REPORT_DOC_BASE_URL) {
		const rel = object.slice('report-files/'.length).replace(/\.[^/.]+$/, '');
		return `${REPORT_DOC_BASE_URL}/${rel.split('/').map(encodeURIComponent).join('/')}`;
	}
	if (config.publicArtifactBaseUrl === REPORT_DOC_BASE_URL) return undefined;
	return `${config.publicArtifactBaseUrl.replace(/\/+$/, '')}/${object.split('/').map(encodeURIComponent).join('/')}`;
}
