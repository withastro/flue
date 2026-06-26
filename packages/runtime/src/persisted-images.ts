import type { DirectAgentSubmissionInput } from './runtime/agent-submissions.ts';
import { MAX_IMAGE_DATA_LENGTH } from './runtime/schemas.ts';
import type { PromptImage } from './types.ts';

export { MAX_IMAGE_DATA_LENGTH };
export const IMAGE_DATA_CHUNK_LENGTH = 256 * 1024;

const markerPrefix = '__flue_image_chunks__:';

type ImageBlock = PromptImage | (Omit<PromptImage, 'data'> & { data: string });
export interface PersistedImageChunk {
	imageId: string;
	index: number;
	count: number;
	data: string;
}

export interface ExtractedImages<T> {
	value: T;
	chunks: PersistedImageChunk[];
}

/**
 * Operation entry points (prompt/skill/task) call this before any history
 * mutation so oversized images are rejected identically across session store
 * adapters, instead of failing later inside SQL persistence and leaving an
 * unsaveable entry in in-memory history. The check inside
 * `extractImageBlocks` remains as a persistence-layer invariant.
 */
export function assertImagesWithinLimit(images: readonly PromptImage[] | undefined): void {
	for (const image of images ?? []) {
		if (image.data.length > MAX_IMAGE_DATA_LENGTH) {
			throw new Error(`[flue] Image data exceeds the ${MAX_IMAGE_DATA_LENGTH} character limit.`);
		}
	}
}

export function extractDirectSubmissionImages(
	input: DirectAgentSubmissionInput,
): ExtractedImages<DirectAgentSubmissionInput> {
	const extracted = extractImageArray(input.payload.images);
	return {
		value: {
			...input,
			payload: {
				...input.payload,
				...(extracted.value === undefined ? {} : { images: extracted.value }),
			},
		},
		chunks: extracted.chunks,
	};
}

export function hydrateDirectSubmissionImages(
	input: DirectAgentSubmissionInput,
	imageData: ReadonlyMap<string, string>,
): DirectAgentSubmissionInput {
	if (input.payload.images === undefined) {
		assertExactImageGroups([], imageData);
		return input;
	}
	assertExactImageGroups(markerIds(input.payload.images), imageData);
	return {
		...input,
		payload: {
			...input.payload,
			images: hydrateImageArray(input.payload.images, imageData),
		},
	};
}

function extractImageArray(
	images: PromptImage[] | undefined,
): ExtractedImages<PromptImage[] | undefined> {
	if (images === undefined) return { value: undefined, chunks: [] };
	return extractImageBlocks(images) as ExtractedImages<PromptImage[]>;
}

function extractImageBlocks(blocks: unknown[]): ExtractedImages<unknown[]> {
	const chunks: PersistedImageChunk[] = [];
	let imageIndex = 0;
	const value = blocks.map((block) => {
		if (!isImageBlock(block)) return block;
		if (block.data.length > MAX_IMAGE_DATA_LENGTH) {
			throw new Error(`[flue] Image data exceeds the ${MAX_IMAGE_DATA_LENGTH} character limit.`);
		}
		const imageId = String(imageIndex++);
		const count = Math.max(1, Math.ceil(block.data.length / IMAGE_DATA_CHUNK_LENGTH));
		for (let index = 0; index < count; index++) {
			chunks.push({
				imageId,
				index,
				count,
				data: block.data.slice(
					index * IMAGE_DATA_CHUNK_LENGTH,
					(index + 1) * IMAGE_DATA_CHUNK_LENGTH,
				),
			});
		}
		return { ...block, data: `${markerPrefix}${imageId}` };
	});
	return { value, chunks };
}

function markerIds(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((block) => {
		if (!isImageBlock(block) || !block.data.startsWith(markerPrefix)) return [];
		return [block.data.slice(markerPrefix.length)];
	});
}

function assertExactImageGroups(
	markerImageIds: string[],
	imageData: ReadonlyMap<string, string>,
): void {
	const markers = new Set(markerImageIds);
	if (markers.size !== markerImageIds.length || markers.size !== imageData.size) {
		throw new Error('[flue] Persisted image chunks do not match persisted image markers.');
	}
	for (const imageId of imageData.keys()) {
		if (!markers.has(imageId)) {
			throw new Error('[flue] Persisted image chunks do not match persisted image markers.');
		}
	}
}

function hydrateImageArray<T>(blocks: T[], imageData: ReadonlyMap<string, string>): T[] {
	return blocks.map((block) => {
		if (!isImageBlock(block) || !block.data.startsWith(markerPrefix)) return block;
		const data = imageData.get(block.data.slice(markerPrefix.length));
		if (data === undefined) throw new Error('[flue] Persisted image chunks are missing.');
		return { ...block, data };
	}) as T[];
}

function isImageBlock(value: unknown): value is ImageBlock {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const block = value as { type?: unknown; data?: unknown };
	return block.type === 'image' && typeof block.data === 'string';
}
