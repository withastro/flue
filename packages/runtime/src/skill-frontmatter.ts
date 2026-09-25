import { FAILSAFE_SCHEMA, load } from 'js-yaml';

export interface ParsedSkillMarkdown {
	name: string;
	description: string;
	body: string;
	license?: string;
	compatibility?: string;
	metadata?: Record<string, string>;
	/**
	 * Tool names from the `allowed-tools` frontmatter field, split on
	 * whitespace. Parsed and retained for Agent Skills spec compatibility;
	 * Flue does not enforce it.
	 */
	allowedTools?: string[];
}

export interface ParseSkillMarkdownOptions {
	directoryName: string;
	path: string;
}

export function parseSkillMarkdown(
	content: string,
	options: ParseSkillMarkdownOptions,
): ParsedSkillMarkdown {
	const match = content
		.replace(/^\uFEFF/, '')
		.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/);
	if (!match) {
		throw new Error(
			`[flue] Skill ${options.path} is missing YAML frontmatter. Start SKILL.md with "---", include "name" and "description", then close the block with "---".`,
		);
	}

	// The Agent Skills reference implementation (skills-ref) parses frontmatter
	// with strictyaml, where every scalar is a string. FAILSAFE_SCHEMA mirrors
	// that, so unquoted values such as `version: 1.0` or `license: 2.0` stay
	// strings instead of becoming typed scalars that fail string validation.
	let raw: unknown;
	try {
		raw = load(match[1] ?? '', { schema: FAILSAFE_SCHEMA });
	} catch (error) {
		const detail = error instanceof Error ? ` ${error.message}` : '';
		throw new Error(`[flue] Skill ${options.path} has invalid YAML frontmatter.${detail}`);
	}
	if (!isRecord(raw)) {
		throw new Error(`[flue] Skill ${options.path} frontmatter must be a YAML mapping.`);
	}

	// Unknown frontmatter fields are deliberately ignored: `skills-ref validate`
	// flags them, but rejecting them at load time would break otherwise-valid
	// third-party skills carrying host-specific extras.
	const name = requireString(raw.name, options.path, 'name');
	validateSkillName(name, options);
	const description = requireString(raw.description, options.path, 'description');
	if ([...description].length > 1024) {
		throw new Error(
			`[flue] Skill ${options.path} frontmatter description exceeds the 1024-character Agent Skills limit. Shorten "description" to a concise one-line summary.`,
		);
	}

	const license = optionalString(raw.license, options.path, 'license');
	const compatibility = optionalString(raw.compatibility, options.path, 'compatibility');
	if (compatibility !== undefined && [...compatibility].length > 500) {
		throw new Error(`[flue] Skill ${options.path} compatibility must be at most 500 characters.`);
	}

	return {
		name,
		description,
		body: (match[2] ?? '').trim(),
		license,
		compatibility,
		metadata: parseMetadata(raw.metadata, options.path),
		allowedTools: parseAllowedTools(raw['allowed-tools'], options.path),
	};
}

function validateSkillName(name: string, options: ParseSkillMarkdownOptions): void {
	if (name.length > 64) {
		throw new Error(`[flue] Skill ${options.path} name must be at most 64 characters.`);
	}
	if (!/^[a-z0-9-]+$/.test(name)) {
		throw new Error(
			`[flue] Skill ${options.path} frontmatter name "${name}" must contain only lowercase ASCII letters, numbers, and hyphens. Use a spec-compliant value such as "review-pr".`,
		);
	}
	if (name.startsWith('-') || name.endsWith('-') || name.includes('--')) {
		throw new Error(
			`[flue] Skill ${options.path} frontmatter name "${name}" must not start or end with a hyphen or contain consecutive hyphens. Use a spec-compliant value such as "review-pr".`,
		);
	}
	if (name !== options.directoryName) {
		throw new Error(
			`[flue] Skill ${options.path} declares frontmatter name "${name}", but Agent Skills requires it to match directory "${options.directoryName}"; names must match. Rename the directory or change "name" so they match.`,
		);
	}
}

function requireString(value: unknown, path: string, field: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`[flue] Skill ${path} must define frontmatter ${field} as a non-empty string.`);
	}
	return value.trim();
}

function optionalString(value: unknown, path: string, field: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string') {
		throw new Error(`[flue] Skill ${path} frontmatter ${field} must be a string when provided.`);
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function parseMetadata(value: unknown, path: string): Record<string, string> | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) {
		throw new Error(
			`[flue] Skill ${path} frontmatter metadata must be a string-to-string mapping.`,
		);
	}
	const entries = Object.entries(value).map(([key, metadataValue]) => {
		// FAILSAFE_SCHEMA already keeps scalars as strings; an empty value
		// parses as null, which skills-ref reads as the empty string.
		if (metadataValue === null) return [key, ''] as const;
		if (typeof metadataValue !== 'string') {
			throw new Error(
				`[flue] Skill ${path} frontmatter metadata must be a string-to-string mapping.`,
			);
		}
		return [key, metadataValue] as const;
	});
	return Object.fromEntries(entries);
}

function parseAllowedTools(value: unknown, path: string): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string') {
		throw new Error(
			`[flue] Skill ${path} frontmatter allowed-tools must be a string when provided.`,
		);
	}
	const tools = value.trim().split(/\s+/).filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
