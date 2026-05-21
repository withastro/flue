import type { Workspace } from '@cloudflare/shell';

export interface HydrateFromBucketOptions {
	/** Only copy keys under this prefix. The prefix is stripped from Workspace paths. */
	prefix?: string;
}

/**
 * Copy matching R2 objects into a Workspace.
 *
 * Hydration is eager, paginated, not idempotent, and does not roll back
 * partial writes. Callers should gate it with their own sentinel file.
 */
export async function hydrateFromBucket(
	workspace: Workspace,
	bucket: R2Bucket,
	options?: HydrateFromBucketOptions,
): Promise<void> {
	const prefix = options?.prefix;
	let cursor: string | undefined;

	while (true) {
		const listing = await bucket.list({ prefix, cursor });
		for (const obj of listing.objects) {
			const relativeKey = stripPrefix(obj.key, prefix);
			if (relativeKey === '' || relativeKey.endsWith('/')) continue;

			const body = await bucket.get(obj.key);
			if (!body) continue;

			await workspace.writeFileBytes(
				absolutize(relativeKey),
				new Uint8Array(await body.arrayBuffer()),
			);
		}

		if (!listing.truncated) break;
		if (!listing.cursor) {
			throw new Error('[flue] R2 listing was truncated but did not include a cursor.');
		}
		cursor = listing.cursor;
	}
}

function stripPrefix(key: string, prefix: string | undefined): string {
	if (!prefix) return key;
	return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

function absolutize(key: string): string {
	return key.startsWith('/') ? key : `/${key}`;
}
