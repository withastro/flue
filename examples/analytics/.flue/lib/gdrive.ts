import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { type FetchLike, readJsonResponse, requireEnvToken } from './http.ts';

export interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	size?: string;
	modifiedTime?: string;
	webViewLink?: string;
	parents?: string[];
}

export interface DriveSearchInput {
	text?: string;
	name?: string;
	mimeType?: string;
	folder?: string;
	after?: string;
	limit?: number;
	token?: string;
	fetchImpl?: FetchLike;
}

export interface DriveReadInput {
	fileId: string;
	token?: string;
	fetchImpl?: FetchLike;
	maxBytes?: number;
}

export interface DriveDownloadInput {
	fileId: string;
	outputPath?: string;
	outputDir?: string;
	token?: string;
	fetchImpl?: FetchLike;
}

export interface DriveCreateInput {
	name: string;
	content?: string;
	mimeType?: string;
	folder?: string;
	token?: string;
	fetchImpl?: FetchLike;
}

export interface DriveUploadInput {
	path: string;
	name?: string;
	mimeType?: string;
	folder?: string;
	token?: string;
	fetchImpl?: FetchLike;
}

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,webViewLink,parents';
const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS})`;
const READ_MAX_BYTES = 100_000;

const EXPORT_MAP: Record<string, { mimeType: string; ext: string }> = {
	'application/vnd.google-apps.document': { mimeType: 'text/plain', ext: '.txt' },
	'application/vnd.google-apps.spreadsheet': { mimeType: 'text/csv', ext: '.csv' },
	'application/vnd.google-apps.presentation': { mimeType: 'text/plain', ext: '.txt' },
	'application/vnd.google-apps.drawing': { mimeType: 'image/png', ext: '.png' },
};

export async function searchDrive(input: DriveSearchInput) {
	const clauses = ['trashed=false'];
	if (input.text) clauses.push(`fullText contains '${escapeDriveQuery(input.text)}'`);
	if (input.name) clauses.push(`name contains '${escapeDriveQuery(input.name)}'`);
	if (input.folder) clauses.push(`'${escapeDriveQuery(input.folder)}' in parents`);
	if (input.mimeType) clauses.push(`mimeType='${escapeDriveQuery(input.mimeType)}'`);
	if (input.after) clauses.push(`modifiedTime > '${escapeDriveQuery(input.after)}'`);
	return listDriveFiles({ ...input, q: clauses.join(' and ') });
}

export async function listDriveFolder(input: { folderId?: string; limit?: number; token?: string; fetchImpl?: FetchLike }) {
	const folderId = input.folderId || 'root';
	return listDriveFiles({ ...input, q: `'${escapeDriveQuery(folderId)}' in parents and trashed=false` });
}

export async function readDriveFile(input: DriveReadInput) {
	const token = driveToken(input.token);
	const fetcher = input.fetchImpl ?? fetch;
	const meta = await getDriveMetadata(fetcher, token, input.fileId);
	const exported = EXPORT_MAP[meta.mimeType];
	const maxBytes = input.maxBytes ?? READ_MAX_BYTES;

	if (exported) {
		const content = await getDriveText(
			fetcher,
			token,
			`${DRIVE_API}/files/${encodeURIComponent(input.fileId)}/export?${new URLSearchParams({
				mimeType: exported.mimeType,
			})}`,
			maxBytes,
		);
		return {
			ok: true,
			file: meta,
			exported_as: exported.mimeType,
			content: content.text,
			truncated: content.truncated,
		};
	}

	if (isTextLike(meta.mimeType)) {
		const content = await getDriveText(
			fetcher,
			token,
			`${DRIVE_API}/files/${encodeURIComponent(input.fileId)}?alt=media`,
			maxBytes,
		);
		return { ok: true, file: meta, content: content.text, truncated: content.truncated };
	}

	return {
		ok: true,
		file: meta,
		content: '',
		truncated: false,
		binary: true,
		message: 'Binary file. Use gdrive_download to save it locally if needed.',
	};
}

export async function downloadDriveFile(input: DriveDownloadInput) {
	const token = driveToken(input.token);
	const fetcher = input.fetchImpl ?? fetch;
	const meta = await getDriveMetadata(fetcher, token, input.fileId);
	const exported = EXPORT_MAP[meta.mimeType];
	const url = exported
		? `${DRIVE_API}/files/${encodeURIComponent(input.fileId)}/export?${new URLSearchParams({ mimeType: exported.mimeType })}`
		: `${DRIVE_API}/files/${encodeURIComponent(input.fileId)}?alt=media`;
	const response = await fetcher(url, { headers: { Authorization: `Bearer ${token}` } });
	if (!response.ok) throw new Error(`Google Drive download HTTP ${response.status}: ${await response.text()}`);
	const buffer = Buffer.from(await response.arrayBuffer());
	const defaultName = exported ? `${meta.name}${exported.ext}` : meta.name;
	const outputPath = input.outputPath || path.join(input.outputDir || process.env.OUTPUT_DIR || '/tmp', defaultName);
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	await fs.writeFile(outputPath, buffer);
	return { ok: true, file: meta, path: outputPath, bytes: buffer.length };
}

export async function createDriveFile(input: DriveCreateInput) {
	const metadata: Record<string, unknown> = { name: input.name };
	if (input.folder) metadata.parents = [input.folder];
	const mimeType = input.mimeType || 'text/plain';
	const content = input.content || '';
	return uploadMultipart({
		token: input.token,
		fetchImpl: input.fetchImpl,
		metadata,
		mimeType,
		body: Buffer.from(content, 'utf8'),
	});
}

export async function uploadDriveFile(input: DriveUploadInput) {
	const stat = await fs.stat(input.path);
	if (!stat.isFile()) throw new Error(`File is not a regular file: ${input.path}`);
	const metadata: Record<string, unknown> = { name: input.name || path.basename(input.path) };
	if (input.folder) metadata.parents = [input.folder];
	const mimeType = input.mimeType || guessMimeType(input.path);
	const body = await fs.readFile(input.path);
	return uploadMultipart({ token: input.token, fetchImpl: input.fetchImpl, metadata, mimeType, body });
}

async function listDriveFiles(input: DriveSearchInput & { q: string }) {
	const token = driveToken(input.token);
	const fetcher = input.fetchImpl ?? fetch;
	const params = new URLSearchParams({
		q: input.q,
		pageSize: String(Math.min(input.limit ?? 20, 100)),
		fields: LIST_FIELDS,
		spaces: 'drive',
	});
	const response = await fetcher(`${DRIVE_API}/files?${params}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const data = await readJsonResponse(response, 'Google Drive list');
	return {
		ok: true,
		files: (Array.isArray(data.files) ? data.files : []).map(normalizeDriveFile),
		nextPageToken: data.nextPageToken,
		query: input.q,
	};
}

async function getDriveMetadata(fetcher: FetchLike, token: string, fileId: string): Promise<DriveFile> {
	const params = new URLSearchParams({ fields: FILE_FIELDS });
	const response = await fetcher(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	return normalizeDriveFile(await readJsonResponse(response, 'Google Drive metadata'));
}

async function getDriveText(fetcher: FetchLike, token: string, url: string, maxBytes: number) {
	const response = await fetcher(url, { headers: { Authorization: `Bearer ${token}` } });
	if (!response.ok) throw new Error(`Google Drive read HTTP ${response.status}: ${await response.text()}`);
	const buffer = Buffer.from(await response.arrayBuffer());
	const truncated = buffer.length > maxBytes;
	const bounded = truncated ? buffer.subarray(0, maxBytes) : buffer;
	return { text: bounded.toString('utf8'), truncated };
}

async function uploadMultipart(input: {
	token?: string;
	fetchImpl?: FetchLike;
	metadata: Record<string, unknown>;
	mimeType: string;
	body: Buffer;
}) {
	const token = driveToken(input.token);
	const fetcher = input.fetchImpl ?? fetch;
	const boundary = `flue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
	const body = Buffer.concat([
		Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
		Buffer.from(JSON.stringify(input.metadata)),
		Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`),
		input.body,
		Buffer.from(`\r\n--${boundary}--\r\n`),
	]);
	const params = new URLSearchParams({ uploadType: 'multipart', fields: FILE_FIELDS });
	const response = await fetcher(`${DRIVE_UPLOAD_API}/files?${params}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': `multipart/related; boundary=${boundary}`,
		},
		body,
	});
	const data = await readJsonResponse(response, 'Google Drive upload');
	return { ok: true, file: normalizeDriveFile(data) };
}

function driveToken(token?: string): string {
	return token || requireEnvToken('GOOGLE_USER_ACCESS_TOKEN', 'Connect Google Drive for the current user before using Drive.');
}

function normalizeDriveFile(file: any): DriveFile {
	return {
		id: String(file.id || ''),
		name: String(file.name || ''),
		mimeType: String(file.mimeType || ''),
		size: optionalString(file.size),
		modifiedTime: optionalString(file.modifiedTime),
		webViewLink: optionalString(file.webViewLink),
		parents: Array.isArray(file.parents) ? file.parents.map(String) : undefined,
	};
}

function escapeDriveQuery(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function isTextLike(mimeType: string): boolean {
	return (
		mimeType.startsWith('text/') ||
		mimeType === 'application/json' ||
		mimeType === 'application/xml' ||
		mimeType === 'application/csv'
	);
}

function guessMimeType(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === '.txt' || ext === '.md') return 'text/plain';
	if (ext === '.csv') return 'text/csv';
	if (ext === '.json') return 'application/json';
	if (ext === '.html') return 'text/html';
	if (ext === '.pdf') return 'application/pdf';
	return 'application/octet-stream';
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value : undefined;
}
