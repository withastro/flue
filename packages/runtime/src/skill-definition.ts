import { SkillDefinitionValidationError, type ValidationIssue } from './errors.ts';
import { buildPackagedSkill } from './skill-package.ts';
import type { PackagedSkillDirectory, RegisteredSkill, SkillDefinition } from './types.ts';

const encoder = new TextEncoder();

/**
 * Declare an inline skill. A typing helper in the `defineTool()` mold: it
 * validates the definition and returns it frozen — no packaging or other
 * work happens here. The runtime packages a definition into the same shape
 * a `SKILL.md` import produces lazily, the first time the skill is needed.
 *
 * `useSkill(...)` also accepts the same object inline (same validation,
 * applied at the mount site).
 */
export function defineSkill(definition: SkillDefinition): SkillDefinition {
	assertSkillDefinition(definition, 'defineSkill()');
	return Object.freeze({
		name: definition.name,
		description: definition.description,
		instructions: definition.instructions,
		license: definition.license,
		compatibility: definition.compatibility,
		metadata: definition.metadata,
		allowedTools: definition.allowedTools,
		files: definition.files,
	});
}

/** True for the inline-definition member of {@link RegisteredSkill}. */
export function isSkillDefinition(skill: RegisteredSkill): skill is SkillDefinition {
	return !('__flueSkillReference' in skill) && !('__flueWorkspaceSkill' in skill);
}

const packagedDefinitions = new WeakMap<SkillDefinition, PackagedSkillDirectory>();

/**
 * Package an inline definition into the directory shape a `SKILL.md` import
 * produces: a synthesized spec-valid `SKILL.md` plus the definition's
 * supporting files. Validates on the way in (definitions can reach the
 * runtime without passing through `defineSkill`), and caches per definition
 * object so repeated activation never re-serializes.
 */
export function packageSkillDefinition(definition: SkillDefinition): PackagedSkillDirectory {
	const cached = packagedDefinitions.get(definition);
	if (cached) return cached;
	const normalized = normalizeSkillDefinition(definition, 'skill definition');
	const files = [
		{ path: 'SKILL.md', content: encoder.encode(serializeSkillMarkdown(normalized)) },
		...Object.entries(normalized.files).map(([path, value]) => ({
			path,
			content: typeof value === 'string' ? encoder.encode(value) : value,
		})),
	];
	const packaged = buildPackagedSkill({
		name: normalized.name,
		description: normalized.description,
		files,
	});
	packagedDefinitions.set(definition, packaged);
	return packaged;
}

/**
 * Validate an inline skill definition — the shared check behind
 * `defineSkill()` and an inline `useSkill({...})` mount.
 */
export function assertSkillDefinition(
	value: unknown,
	label: string,
): asserts value is SkillDefinition {
	normalizeSkillDefinition(value, label);
}

interface NormalizedSkillDefinition {
	name: string;
	description: string;
	instructions: string;
	license?: string;
	compatibility?: string;
	metadata?: Record<string, string>;
	allowedTools?: string;
	files: Record<string, string | Uint8Array>;
}

function normalizeSkillDefinition(value: unknown, label: string): NormalizedSkillDefinition {
	const issues: ValidationIssue[] = [];
	if (!isRecord(value)) {
		throw new SkillDefinitionValidationError({
			issues: [{ path: [], message: `${label} requires a skill definition object.` }],
		});
	}
	const options = value as Partial<SkillDefinition>;
	const name = requiredString(options.name, 'name', issues);
	if (name.length > 64) issues.push({ path: ['name'], message: 'Must be at most 64 characters.' });
	if (name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
		issues.push({
			path: ['name'],
			message: 'Must contain only lowercase ASCII letters, numbers, and single hyphens.',
		});
	}
	const description = requiredString(options.description, 'description', issues);
	if ([...description].length > 1024) {
		issues.push({ path: ['description'], message: 'Must be at most 1024 characters.' });
	}
	const instructions = requiredString(options.instructions, 'instructions', issues);
	const license = optionalString(options.license, 'license', issues);
	const compatibility = optionalString(options.compatibility, 'compatibility', issues);
	if (compatibility !== undefined && [...compatibility].length > 500) {
		issues.push({ path: ['compatibility'], message: 'Must be at most 500 characters.' });
	}
	const allowedTools = optionalString(options.allowedTools, 'allowedTools', issues);
	const metadata: Record<string, string> | undefined =
		options.metadata === undefined ? undefined : Object.create(null);
	if (options.metadata !== undefined) {
		if (!isRecord(options.metadata)) {
			issues.push({ path: ['metadata'], message: 'Must be a string-to-string mapping.' });
		} else {
			for (const [key, entry] of Object.entries(options.metadata)) {
				if (typeof entry !== 'string') {
					issues.push({ path: ['metadata', key], message: 'Must be a string.' });
				} else if (metadata) {
					metadata[key] = entry;
				}
			}
		}
	}
	const files: Record<string, string | Uint8Array> = Object.create(null);
	if (options.files !== undefined) {
		if (!isRecord(options.files)) {
			issues.push({ path: ['files'], message: 'Must be a file-path mapping.' });
		} else {
			for (const [path, content] of Object.entries(options.files)) {
				validateFilePath(path, issues);
				if (typeof content !== 'string' && !(content instanceof Uint8Array)) {
					issues.push({ path: ['files', path], message: 'Must be a string or Uint8Array.' });
				} else {
					files[path] = typeof content === 'string' ? content : new Uint8Array(content);
				}
			}
		}
	}
	if (issues.length > 0) throw new SkillDefinitionValidationError({ issues });
	return { name, description, instructions, license, compatibility, metadata, allowedTools, files };
}

function requiredString(value: unknown, field: string, issues: ValidationIssue[]): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		issues.push({ path: [field], message: 'Must be a non-empty string.' });
		return '';
	}
	return value.trim();
}

function optionalString(
	value: unknown,
	field: string,
	issues: ValidationIssue[],
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'string') {
		issues.push({ path: [field], message: 'Must be a string when provided.' });
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function validateFilePath(path: string, issues: ValidationIssue[]): void {
	const segments = path.split('/');
	if (
		path.length === 0 ||
		path === 'SKILL.md' ||
		path.startsWith('/') ||
		path.endsWith('/') ||
		path.includes('\\') ||
		path.includes('\0') ||
		segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
	) {
		issues.push({
			path: ['files', path],
			message: 'Must be a safe relative path and must not be SKILL.md.',
		});
	}
}

function serializeSkillMarkdown(options: NormalizedSkillDefinition): string {
	const lines = [
		'---',
		`name: ${JSON.stringify(options.name)}`,
		`description: ${JSON.stringify(options.description)}`,
	];
	if (options.license !== undefined) lines.push(`license: ${JSON.stringify(options.license)}`);
	if (options.compatibility !== undefined) {
		lines.push(`compatibility: ${JSON.stringify(options.compatibility)}`);
	}
	if (options.metadata !== undefined) {
		lines.push('metadata:');
		for (const key of Object.keys(options.metadata).sort()) {
			lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(options.metadata[key])}`);
		}
	}
	if (options.allowedTools !== undefined) {
		lines.push(`allowed-tools: ${JSON.stringify(options.allowedTools)}`);
	}
	lines.push('---', '');
	lines.push(options.instructions);
	return `${lines.join('\n')}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
