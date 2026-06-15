interface FrontmatterCommon {
	kind: string;
	version: number;
}

interface FrontmatterBlueprint extends FrontmatterCommon {
	website: string;
	aliases: string[];
	root?: undefined;
}

interface FrontmatterRoot extends FrontmatterCommon {
	root: true;
}

export type BlueprintFrontmatter = FrontmatterBlueprint | FrontmatterRoot;

export interface BlueprintRecord {
	slug: string;
	kind: string;
	version: number;
	website: string;
	aliases: string[];
	file: string;
}

export interface KindRootRecord {
	kind: string;
	version: number;
	file: string;
}

export function validateBlueprintBody(source: string, file: string, version: number): void {
	const lines = source.split('\n');
	const headings: { level: number; text: string; line: number }[] = [];
	let fence: string | undefined;

	for (const [index, line] of lines.entries()) {
		const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
		const marker = fenceMatch?.[1]?.[0];
		if (marker) {
			if (!fence) fence = marker;
			else if (fence === marker) fence = undefined;
			continue;
		}
		if (fence) continue;
		const headingMatch = line.match(/^(#{2,3})\s+(.+?)\s*$/);
		const hashes = headingMatch?.[1];
		const text = headingMatch?.[2];
		if (hashes && text) {
			headings.push({ level: hashes.length, text, line: index });
		}
	}

	const upgradeGuides = headings.filter(
		(heading) => heading.level === 2 && heading.text === 'Upgrade Guide',
	);
	if (upgradeGuides.length !== 1) {
		throw new Error(`[blueprints] ${file}: body must contain exactly one "## Upgrade Guide".`);
	}
	const [upgradeGuide] = upgradeGuides;
	if (!upgradeGuide) {
		throw new Error(`[blueprints] ${file}: body must contain exactly one "## Upgrade Guide".`);
	}
	const lastH2 = headings.filter((heading) => heading.level === 2).at(-1);
	if (lastH2 !== upgradeGuide) {
		throw new Error(`[blueprints] ${file}: "## Upgrade Guide" must be the final H2 section.`);
	}

	const entries = headings.filter((heading) => heading.level === 3 && heading.line > upgradeGuide.line);
	if (entries.length !== version) {
		throw new Error(
			`[blueprints] ${file}: Upgrade Guide must contain exactly ${version} version entries.`,
		);
	}
	for (const [index, entry] of entries.entries()) {
		const expectedVersion = index + 1;
		if (!new RegExp(`^Version ${expectedVersion} — \\d{4}-\\d{2}-\\d{2}$`).test(entry.text)) {
			throw new Error(
				`[blueprints] ${file}: Upgrade Guide entries must be contiguous and use "### Version N — YYYY-MM-DD" headings; expected Version ${expectedVersion}.`,
			);
		}
		const end = entries[index + 1]?.line ?? lines.length;
		const body = lines.slice(entry.line + 1, end).join('\n').trim();
		if (expectedVersion === 1) {
			if (body !== 'Initial version.') {
				throw new Error(
					`[blueprints] ${file}: Version 1 body must be exactly "Initial version.".`,
				);
			}
		} else {
			const diff = /```diff[^\n]*\n([\s\S]*?)\n```/g;
			let match = diff.exec(body);
			let hasUnifiedDiff = false;
			while (match) {
				const diffBody = match[1];
				if (diffBody && /^--- .+$/m.test(diffBody) && /^\+\+\+ .+$/m.test(diffBody)) {
					hasUnifiedDiff = true;
					break;
				}
				match = diff.exec(body);
			}
			if (!hasUnifiedDiff) {
				throw new Error(
					`[blueprints] ${file}: Version ${expectedVersion} must contain a fenced unified diff with "--- " and "+++ " file headers.`,
				);
			}
		}
	}
}

export function parseBlueprintFrontmatter(source: string, file: string): BlueprintFrontmatter {
	if (!source.startsWith('---\n')) {
		throw new Error(`[blueprints] ${file}: missing JSON frontmatter (file must start with '---').`);
	}
	const end = source.indexOf('\n---\n', 4);
	if (end < 0) {
		throw new Error(`[blueprints] ${file}: frontmatter is not closed (no trailing '---').`);
	}
	const json = source.slice(4, end).trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (err) {
		throw new Error(
			`[blueprints] ${file}: frontmatter is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!parsed || typeof parsed !== 'object') {
		throw new Error(`[blueprints] ${file}: frontmatter must be a JSON object.`);
	}
	const data = parsed as Record<string, unknown>;
	if (typeof data.kind !== 'string' || !data.kind) {
		throw new Error(`[blueprints] ${file}: frontmatter missing required string field "kind".`);
	}
	if (!Number.isSafeInteger(data.version) || (data.version as number) <= 0) {
		throw new Error(
			`[blueprints] ${file}: frontmatter missing required positive integer field "version".`,
		);
	}
	const version = data.version as number;
	if (data.root === true) {
		return { kind: data.kind, version, root: true };
	}
	if (typeof data.website !== 'string' || !data.website) {
		throw new Error(
			`[blueprints] ${file}: frontmatter missing required string field "website" (or set "root": true for a kind root).`,
		);
	}
	let aliases: string[] = [];
	if ('aliases' in data && data.aliases !== undefined) {
		if (!Array.isArray(data.aliases)) {
			throw new Error(
				`[blueprints] ${file}: frontmatter "aliases" must be an array of strings if present.`,
			);
		}
		for (const alias of data.aliases) {
			if (typeof alias !== 'string' || !alias.trim()) {
				throw new Error(
					`[blueprints] ${file}: frontmatter "aliases" must contain only non-empty strings.`,
				);
			}
		}
		aliases = data.aliases;
	}
	return { kind: data.kind, version, website: data.website, aliases };
}
