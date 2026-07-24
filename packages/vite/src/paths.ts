/**
 * Filesystem path helpers shared by the build's directory-identity checks
 * (output-directory safety, skill-directory tracking): comparing paths as
 * text alone misses aliases — a differently cased Windows drive letter or a
 * junction/symlink pointing at the same directory passes a naive string
 * check while still naming the same place on disk.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Canonicalize a path for identity comparison: resolve the nearest existing
 * ancestor through symlinks, directory junctions, and on-disk casing
 * (realpath.native), then re-append any nonexistent tail. Callers that need
 * a Vite-normalized (forward-slash) path should wrap the result in
 * `normalizePath`.
 */
export function canonicalizePath(target: string): string {
	const missing: string[] = [];
	let existing = target;
	while (!fs.existsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) break;
		missing.unshift(path.basename(existing));
		existing = parent;
	}
	let real = existing;
	try {
		real = fs.realpathSync.native(existing);
	} catch {
		// Unreadable ancestor: fall back to the textual form.
	}
	return path.join(real, ...missing);
}

/** Whether `filePath` is `directory` itself or nested under it. */
export function isWithinDirectory(filePath: string, directory: string): boolean {
	return filePath === directory || filePath.startsWith(`${directory}/`);
}
