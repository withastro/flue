/**
 * Shared "use agent" scanner.
 *
 * THE AGENT IS THE FUNCTION: in a `'use agent'` module, every exported
 * function with a capitalized name is an agent (the React convention —
 * capitalized = component). The scanned set of agents IS the app's agent
 * registry on both targets (Node and Cloudflare): the generated bootstrap
 * imports and registers every scanned agent, and the Cloudflare target
 * additionally emits one Durable Object class per agent. See
 * plans/2026-07-11-agent-is-the-function-design.md.
 *
 * The scan is a directory glob over the project source root (overridable via
 * the `agents` glob in flue.config.ts) filtered to files whose ECMAScript
 * directive prologue contains the `use agent` directive. Prologue detection
 * uses the oxc parser that ships with Vite (`parseAstAsync`), so shebangs,
 * comments, `'use strict'` ordering, and ASI all follow real ECMAScript
 * semantics — no regex-over-the-file heuristics.
 *
 * Identity: the exported function's name, unless the module assigns the
 * `agentName` static — `MyAgent.agentName = '<literal>'` — at the top level.
 * The literal-only rule is load-bearing: build targets derive Durable Object
 * class/binding names from the identity before any user code runs, and the
 * stamped literal is what keeps identity safe from minification.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AGENT_IDENTITY_PATTERN } from '@flue/runtime/internal';
import { glob } from 'tinyglobby';
import { parseAstAsync } from 'vite';

/** The module directive that marks a file as a Flue agent module. */
export const AGENT_DIRECTIVE = 'use agent';

/**
 * Agent identities (exported function names, or their `agentName` static
 * override) key durable storage everywhere (Durable Object class + binding
 * names on Cloudflare, conversation storage slugs on Node), so they are
 * restricted to predictable identifier-ish shapes: PascalCase function names
 * (`IssueTriage`) and kebab-case overrides (`issue-triage`) both match. The
 * canonical pattern is imported from `@flue/runtime` so the scan and
 * registration never drift.
 */

/** Module extensions that can carry the `'use agent'` directive. */
const AGENT_MODULE_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs']);

const DEFAULT_SCAN_PATTERNS = ['**/*.{ts,mts,js,mjs}'];

/**
 * Directories that never contain authored agent modules: installed
 * dependencies and build output. Generated directories (`.wrangler`,
 * `.flue`, …) and other dotfiles/dot-directories are excluded by
 * tinyglobby's default `dot: false`, but the Flue-adjacent ones are listed
 * explicitly so an `agents` override with `dot: true` semantics can never
 * resurrect them.
 */
const EXCLUDED_DIRECTORY_PATTERNS = ['**/node_modules/**', '**/dist/**', '**/.wrangler/**'];

export interface ScanAgentsOptions {
	/** Absolute path to the project source root the scan runs over. */
	readonly sourceRoot: string;
	/**
	 * Optional glob(s), relative to {@link ScanAgentsOptions.sourceRoot},
	 * narrowing the scan (the `agents` field of flue.config.ts). Defaults to a
	 * recursive scan of the source root. Matches are still restricted to
	 * `.ts`/`.mts`/`.js`/`.mjs` modules and the standard exclusions.
	 */
	readonly agents?: string | readonly string[];
}

/** One scanned agent — an exported capitalized function of a marked module. */
export interface AgentScanResult {
	/** Absolute path of the agent's module. */
	readonly filePath: string;
	/** The export the agent function rides (`'default'` for default exports). */
	readonly exportName: string;
	/**
	 * The agent's durable identity: the `agentName` static override when
	 * assigned, else the exported function's name. Keys durable storage on
	 * both targets.
	 */
	readonly identity: string;
	/** Generated Durable Object class name, e.g. `FlueIssueTriageAgent`. */
	readonly className: string;
	/** Generated Durable Object binding name, e.g. `FLUE_ISSUE_TRIAGE_AGENT`. */
	readonly bindingName: string;
}

/** Base class for structured `scanAgents()` failures. */
class AgentScanError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		// Every scan failure is an expected user mistake (duplicate identity,
		// bad agent name, broken module): the message is the diagnostic, and a
		// framework stack under it buries the fix.
		this.stack = this.message;
	}
}

/** Two or more scanned agents resolve to the same identity. */
export class DuplicateAgentIdentityError extends AgentScanError {
	readonly duplicates: ReadonlyArray<{
		readonly identity: string;
		readonly filePaths: readonly string[];
	}>;

	constructor(
		duplicates: ReadonlyArray<{ readonly identity: string; readonly filePaths: readonly string[] }>,
	) {
		const list = duplicates
			.map(({ identity, filePaths }) => `"${identity}" (${filePaths.join(', ')})`)
			.join('; ');
		super(
			`[flue] Duplicate agent identit${duplicates.length === 1 ? 'y' : 'ies'} among 'use agent' modules: ${list}. ` +
				`The identity (the exported function name, or its \`agentName\` static override) is the agent's durable ` +
				`identity, so it must be unique across the app. Rename the conflicting function(s) or assign distinct ` +
				`agentName overrides.`,
		);
		this.duplicates = duplicates;
	}
}

/** Two distinct agent identities fold to the same generated durable identifier. */
export class AgentIdentifierCollisionError extends AgentScanError {
	readonly collisions: ReadonlyArray<{
		/** The colliding generated name (a DO class or binding name). */
		readonly identifier: string;
		readonly agents: ReadonlyArray<{ readonly identity: string; readonly filePath: string }>;
	}>;

	constructor(
		collisions: ReadonlyArray<{
			readonly identifier: string;
			readonly agents: ReadonlyArray<{ readonly identity: string; readonly filePath: string }>;
		}>,
	) {
		const list = collisions
			.map(
				({ identifier, agents }) =>
					`${identifier} from ${agents
						.map(({ identity, filePath }) => `"${identity}" (${filePath})`)
						.join(' and ')}`,
			)
			.join('; ');
		super(
			`[flue] Distinct agent identities collide on generated durable identifiers: ${list}. ` +
				`Durable Object class and binding names fold case and dashes (\`issue-triage\` and \`IssueTriage\` ` +
				`both become FlueIssueTriageAgent), so these identities cannot coexist. Rename one of the ` +
				`conflicting agents or give it a distinct \`agentName\` override.`,
		);
		this.collisions = collisions;
	}
}

/** The same local function is exported under two different agent names. */
export class DuplicateAgentExportError extends AgentScanError {
	readonly filePath: string;
	readonly functionName: string;
	readonly exportNames: readonly string[];

	constructor(filePath: string, functionName: string, exportNames: readonly string[]) {
		super(
			`[flue] ${filePath} exports the function \`${functionName}\` under two agent names ` +
				`(${exportNames.map((name) => `"${name}"`).join(', ')}). An agent registers once, keyed by its ` +
				`export name, so the same function cannot be two agents — export it under a single name, or alias it ` +
				`to a non-agent (lowercase) name if the extra export is not meant to be an agent.`,
		);
		this.filePath = filePath;
		this.functionName = functionName;
		this.exportNames = exportNames;
	}
}

/** A scanned agent's identity (function name or `agentName` override) is invalid. */
export class InvalidAgentIdentityError extends AgentScanError {
	readonly invalidAgents: ReadonlyArray<{
		readonly identity: string;
		readonly filePath: string;
	}>;

	constructor(
		invalidAgents: ReadonlyArray<{ readonly identity: string; readonly filePath: string }>,
	) {
		const list = invalidAgents
			.map(({ identity, filePath }) => `${filePath} (agent: ${identity})`)
			.join(', ');
		super(
			`[flue] Agent identities (the exported function name, or its \`agentName\` static override) must match ` +
				`${AGENT_IDENTITY_PATTERN} so generated durable identifiers remain predictable. Invalid agent(s): ${list}.`,
		);
		this.invalidAgents = invalidAgents;
	}
}

/** An agent's `agentName` static is assigned in a form the build cannot read statically. */
export class InvalidAgentNameStaticError extends AgentScanError {
	readonly filePath: string;

	constructor(filePath: string, agentName: string, position: { line: number; column: number }) {
		super(
			`[flue] ${filePath}:${position.line}:${position.column} — \`${agentName}.agentName\` is the agent's ` +
				`durable identity and must be statically readable: \`${agentName}.agentName = '<literal>'\` at the ` +
				`top level of the module. Build targets derive Durable Object class and binding names from it ` +
				`before any code runs, so a computed or conditional \`agentName\` cannot be supported.`,
		);
		this.filePath = filePath;
	}
}

/** A `'use agent'` module default-exports an anonymous function. */
export class AnonymousAgentExportError extends AgentScanError {
	readonly filePath: string;

	constructor(filePath: string, position: { line: number; column: number }) {
		super(
			`[flue] ${filePath}:${position.line}:${position.column} — a 'use agent' module default-exports an ` +
				`anonymous function. An agent's identity derives from its function name, so agents must be named: ` +
				`\`export default function MyAgent() { … }\` (or a named export).`,
		);
		this.filePath = filePath;
	}
}

/** A `'use agent'` module exports no agents (no capitalized exported functions). */
export class NoAgentExportsError extends AgentScanError {
	readonly filePath: string;

	constructor(filePath: string) {
		super(
			`[flue] ${filePath} declares 'use agent' but exports no agents. In a marked module, every exported ` +
				`function with a capitalized name is an agent — export one (e.g. \`export function MyAgent() { … }\`), ` +
				`or remove the directive.`,
		);
		this.filePath = filePath;
	}
}

/** A `'use agent'` candidate module could not be parsed. */
export class AgentModuleParseError extends AgentScanError {
	readonly filePath: string;

	constructor(filePath: string, cause: unknown) {
		super(
			`[flue] Unable to parse "${filePath}" while scanning for 'use agent' modules: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
		this.filePath = filePath;
	}
}

/**
 * Scan the source root for `'use agent'` modules and derive their agents'
 * durable identifiers. Results are sorted by file path (then source order
 * within a file) so the scan is deterministic.
 */
export async function scanAgents(options: ScanAgentsOptions): Promise<AgentScanResult[]> {
	const sourceRoot = path.resolve(options.sourceRoot);
	const patterns =
		options.agents === undefined
			? DEFAULT_SCAN_PATTERNS
			: typeof options.agents === 'string'
				? [options.agents]
				: [...options.agents];

	const matches = await glob(patterns, {
		cwd: sourceRoot,
		ignore: EXCLUDED_DIRECTORY_PATTERNS,
		absolute: true,
		onlyFiles: true,
	});

	const filePaths = [...new Set(matches.map((match) => path.normalize(match)))]
		.filter((filePath) => isAgentModulePath(filePath))
		.sort(comparePaths);

	const scans = new Map<string, AgentModuleScan>();
	await Promise.all(
		filePaths.map(async (filePath) => {
			scans.set(filePath, await scanAgentModuleFile(filePath));
		}),
	);

	const results: AgentScanResult[] = [];
	for (const filePath of filePaths) {
		const scan = scans.get(filePath);
		if (!scan?.hasDirective) continue;
		if (scan.agents.length === 0) throw new NoAgentExportsError(filePath);
		for (const agent of scan.agents) {
			results.push({
				filePath,
				exportName: agent.exportName,
				identity: agent.identity,
				className: agentClassName(agent.identity),
				bindingName: agentBindingName(agent.identity),
			});
		}
	}

	assertValidIdentities(results);
	assertUniqueIdentities(results);
	assertUniqueDurableIdentifiers(results);
	return results;
}

/** Whether `filePath` has an extension that can carry the agent directive. */
export function isAgentModulePath(filePath: string): boolean {
	return AGENT_MODULE_EXTENSIONS.has(path.extname(filePath));
}

/** `Flue<PascalCase>Agent` — matches the Cloudflare codegen exactly. */
export function agentClassName(identity: string): string {
	return `Flue${pascalCaseName(identity)}Agent`;
}

/** `FLUE_<SNAKE_UPPER>_AGENT` — camel boundaries split, so `IssueTriage` → `FLUE_ISSUE_TRIAGE_AGENT`. */
export function agentBindingName(identity: string): string {
	return `FLUE_${snakeUpperName(identity)}_AGENT`;
}

function pascalCaseName(name: string): string {
	return name
		.split(/[-_]/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join('');
}

function snakeUpperName(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.replace(/-/g, '_')
		.toUpperCase();
}

function comparePaths(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Minimal structural view of the oxc ESTree output: directive-prologue
 * statements are `ExpressionStatement`s carrying a `directive` field with the
 * RAW source between the quotes. Matching on the raw text mirrors how
 * ECMAScript recognizes `"use strict"` — escape sequences (e.g.
 * `'use\x20agent'`) do not count as the directive.
 */
interface ParsedStatement {
	readonly type: string;
	readonly directive?: string;
	readonly start?: number;
}

/**
 * Whether a parsed program body opens with the `'use agent'` directive in its
 * directive prologue. Shared by the scanner and the `@flue/vite` build
 * transform so the two can never disagree about what counts as an agent
 * module.
 */
function programBodyHasAgentDirective(body: readonly unknown[]): boolean {
	return findAgentDirectiveStatement(body) !== undefined;
}

/** The `'use agent'` directive-prologue statement of a parsed program body, if any. */
export function findAgentDirectiveStatement(body: readonly unknown[]): ParsedStatement | undefined {
	for (const entry of body) {
		const statement = entry as ParsedStatement;
		// The directive prologue ends at the first non-directive statement.
		if (statement.type !== 'ExpressionStatement' || typeof statement.directive !== 'string') {
			break;
		}
		if (statement.directive === AGENT_DIRECTIVE) return statement;
	}
	return undefined;
}

/** 1-based line/column of a character offset, for `file:line:column` diagnostics. */
function sourcePosition(code: string, offset: number): { line: number; column: number } {
	const bounded = Math.max(0, Math.min(offset, code.length));
	let line = 1;
	let lineStart = 0;
	for (let index = 0; index < bounded; index += 1) {
		if (code.charCodeAt(index) === 10) {
			line += 1;
			lineStart = index + 1;
		}
	}
	return { line, column: bounded - lineStart + 1 };
}

/** One agent recognized in a marked module. */
export interface AgentExportScan {
	/** The export the agent rides (`'default'` for default exports). */
	readonly exportName: string;
	/** The function's local (source-level) name. */
	readonly functionName: string;
	/** `agentName` static override when assigned, else the exported name. */
	readonly identity: string;
}

/** One candidate module's scan: directive membership plus its agents. */
export interface AgentModuleScan {
	readonly hasDirective: boolean;
	/** The module's agents (exported capitalized functions), in source order. */
	readonly agents: readonly AgentExportScan[];
}

export interface ScanAgentModuleCodeOptions {
	/**
	 * Collect agents only when the module carries the `'use agent'` directive
	 * (the default — directive membership is how the build scan discovers
	 * agent modules). `flue run` names its module by explicit path, so it
	 * passes `false`: the export-shape rule alone decides its agents, keeping
	 * run and build agreement on every module both can see.
	 */
	requireDirective?: boolean;
}

/**
 * Scan `code` (an on-disk module's source) for the `'use agent'` directive
 * and, when marked, its agents — every exported function with a capitalized
 * name, plus each one's `agentName` static override — one parse serves it
 * all. Parse failures throw {@link AgentModuleParseError}: silently skipping
 * a broken candidate would let a build succeed without the agents the file
 * declares. An `agentName` static in any statically unreadable form throws
 * {@link InvalidAgentNameStaticError}; an anonymous default-exported function
 * throws {@link AnonymousAgentExportError}.
 */
export async function scanAgentModuleCode(
	code: string,
	filePath: string,
	options: ScanAgentModuleCodeOptions = {},
): Promise<AgentModuleScan> {
	const requireDirective = options.requireDirective ?? true;
	// Cheap candidate pre-filter: the raw directive text must appear somewhere
	// in the file for the prologue to contain it (raw-text matching, so this
	// can never produce a false negative). Only candidates are parsed.
	if (requireDirective && !code.includes(AGENT_DIRECTIVE)) {
		return { hasDirective: false, agents: [] };
	}
	let body: readonly unknown[];
	try {
		const program = await parseAstAsync(code, { lang: parserLangForFile(filePath) }, filePath);
		body = program.body as readonly unknown[];
	} catch (error) {
		throw new AgentModuleParseError(filePath, error);
	}
	const hasDirective = programBodyHasAgentDirective(body);
	if (requireDirective && !hasDirective) {
		return { hasDirective: false, agents: [] };
	}
	return { hasDirective, agents: collectModuleAgents(body, code, filePath) };
}

// ─── Agent-export collection ────────────────────────────────────────────────

interface AstNode {
	readonly type?: string;
	readonly start?: number;
	readonly id?: { readonly type?: string; readonly name?: string } | null;
	readonly name?: string;
	readonly declaration?: AstNode | null;
	readonly kind?: string;
	readonly declarations?: ReadonlyArray<{
		readonly id?: { readonly type?: string; readonly name?: string };
		readonly init?: unknown;
	}>;
	readonly specifiers?: ReadonlyArray<{
		readonly local?: { readonly name?: unknown };
		readonly exported?: { readonly name?: unknown; readonly value?: unknown };
	}>;
	readonly source?: unknown;
	readonly expression?: AstNode;
	readonly left?: AstNode;
	readonly right?: unknown;
	readonly object?: AstNode;
	readonly property?: AstNode;
	readonly computed?: boolean;
	readonly operator?: string;
}

/** Whether an exported binding's name marks it as an agent. */
function isCapitalized(name: string): boolean {
	const first = name.charCodeAt(0);
	return first >= 65 && first <= 90; // A–Z
}

/** Whether an (unwrapped) expression node is a function value. */
function isFunctionExpressionNode(node: unknown): boolean {
	const type = (node as AstNode | undefined)?.type;
	return type === 'ArrowFunctionExpression' || type === 'FunctionExpression';
}

/**
 * Collect a marked module's agents: exported functions with capitalized
 * names. Recognized forms —
 *
 * - `export function MyAgent() {}`
 * - `export const MyAgent = () => {}` (and `= function () {}`)
 * - `export default function MyAgent() {}` (anonymous default → error)
 * - `export default MyAgent` (identifier → its local function; same rule as
 *   `export { MyAgent as default }`)
 * - `function MyAgent() {}` / `const MyAgent = …` + `export { MyAgent }`
 *   (aliases count under the exported name: `export { helper as MyAgent }`)
 *
 * Re-exports (`export { X } from './other'`, `export * from`) never
 * register: an agent registers where its function is defined. Classes are
 * never agents. Lowercase exports are helpers.
 *
 * Identity: the `agentName` static (`MyAgent.agentName = '<literal>'`,
 * top-level, literal-only), else the exported name (the function's own name
 * for default exports).
 */
function collectModuleAgents(
	body: readonly unknown[],
	code: string,
	filePath: string,
): AgentExportScan[] {
	// Pass 1: top-level function bindings (declarations and const-fn
	// initializers), keyed by local name.
	const localFunctions = new Set<string>();
	for (const entry of body) {
		const node = entry as AstNode;
		const declaration =
			node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration'
				? (node.declaration as AstNode | null)
				: node;
		if (!declaration) continue;
		if (declaration.type === 'FunctionDeclaration' && declaration.id?.name) {
			localFunctions.add(declaration.id.name);
		} else if (declaration.type === 'VariableDeclaration') {
			for (const declarator of declaration.declarations ?? []) {
				if (
					declarator.id?.type === 'Identifier' &&
					declarator.id.name &&
					isFunctionExpressionNode(unwrapExpression(declarator.init))
				) {
					localFunctions.add(declarator.id.name);
				}
			}
		}
	}

	// Pass 2: exported agent bindings, in source order.
	const agents: Array<{ exportName: string; functionName: string }> = [];
	const seenExports = new Set<string>();
	const exportNameByFunction = new Map<string, string>();
	const addAgent = (exportName: string, functionName: string) => {
		if (seenExports.has(exportName)) return;
		const existingExportName = exportNameByFunction.get(functionName);
		if (existingExportName !== undefined && existingExportName !== exportName) {
			throw new DuplicateAgentExportError(filePath, functionName, [existingExportName, exportName]);
		}
		seenExports.add(exportName);
		exportNameByFunction.set(functionName, exportName);
		agents.push({ exportName, functionName });
	};
	for (const entry of body) {
		const node = entry as AstNode;
		if (node.type === 'ExportDefaultDeclaration') {
			const declaration = node.declaration as AstNode | null;
			const unwrapped = unwrapExpression(declaration) as AstNode | null;
			if (declaration?.type === 'FunctionDeclaration') {
				if (!declaration.id?.name) {
					throw new AnonymousAgentExportError(
						filePath,
						sourcePosition(code, node.start ?? declaration.start ?? 0),
					);
				}
				if (isCapitalized(declaration.id.name)) addAgent('default', declaration.id.name);
			} else if (unwrapped?.type === 'Identifier' && typeof unwrapped.name === 'string') {
				// `export default MyAgent` (also `Foo as T` / `Foo satisfies T` / `Foo!`
				// / `(Foo)` via unwrapExpression) — resolve the identifier to its local
				// function, the same rule as `export { MyAgent as default }`.
				if (localFunctions.has(unwrapped.name) && isCapitalized(unwrapped.name)) {
					addAgent('default', unwrapped.name);
				}
			} else if (isFunctionExpressionNode(unwrapped)) {
				// `export default () => {}` — anonymous, so unnameable.
				throw new AnonymousAgentExportError(filePath, sourcePosition(code, node.start ?? 0));
			}
			continue;
		}
		if (node.type !== 'ExportNamedDeclaration') continue;
		if (node.source) continue; // Re-exports never register.
		const declaration = node.declaration as AstNode | null;
		if (declaration?.type === 'FunctionDeclaration' && declaration.id?.name) {
			if (isCapitalized(declaration.id.name)) addAgent(declaration.id.name, declaration.id.name);
		} else if (declaration?.type === 'VariableDeclaration') {
			for (const declarator of declaration.declarations ?? []) {
				if (
					declarator.id?.type === 'Identifier' &&
					declarator.id.name &&
					isCapitalized(declarator.id.name) &&
					isFunctionExpressionNode(unwrapExpression(declarator.init))
				) {
					addAgent(declarator.id.name, declarator.id.name);
				}
			}
		}
		for (const specifier of node.specifiers ?? []) {
			const local = typeof specifier.local?.name === 'string' ? specifier.local.name : undefined;
			const exported =
				typeof specifier.exported?.name === 'string'
					? specifier.exported.name
					: typeof specifier.exported?.value === 'string'
						? specifier.exported.value
						: undefined;
			if (!local || !exported) continue;
			if (exported === 'default') {
				// `export { MyAgent as default }` — same rule as a default declaration.
				if (localFunctions.has(local) && isCapitalized(local)) addAgent('default', local);
			} else if (isCapitalized(exported) && localFunctions.has(local)) {
				addAgent(exported, local);
			}
		}
	}

	// Pass 3: `agentName` static overrides — top-level literal assignments on
	// a recognized agent's local name.
	const agentByLocalName = new Map<string, { exportName: string; functionName: string }>();
	for (const agent of agents) agentByLocalName.set(agent.functionName, agent);
	const overrides = new Map<string, string>();
	for (const entry of body) {
		const node = entry as AstNode;
		if (node.type !== 'ExpressionStatement') continue;
		const expression = node.expression;
		if (expression?.type !== 'AssignmentExpression' || expression.operator !== '=') continue;
		const target = expression.left;
		if (
			target?.type !== 'MemberExpression' ||
			target.computed === true ||
			target.object?.type !== 'Identifier' ||
			typeof target.object.name !== 'string' ||
			target.property?.type !== 'Identifier' ||
			target.property.name !== 'agentName'
		) {
			continue;
		}
		const localName = target.object.name;
		if (!agentByLocalName.has(localName)) continue;
		const literal = unwrapExpression(expression.right) as {
			readonly type?: string;
			readonly value?: unknown;
		};
		if (literal?.type !== 'Literal' || typeof literal.value !== 'string') {
			throw new InvalidAgentNameStaticError(
				filePath,
				localName,
				sourcePosition(code, node.start ?? 0),
			);
		}
		overrides.set(localName, literal.value);
	}

	// Identity default: the public (exported) name; the function's own name
	// for default exports, where 'default' names the slot, not the agent.
	return agents.map((agent) => ({
		exportName: agent.exportName,
		functionName: agent.functionName,
		identity:
			overrides.get(agent.functionName) ??
			(agent.exportName === 'default' ? agent.functionName : agent.exportName),
	}));
}

/** Strip TS type-position wrappers (`as`, `satisfies`, `!`, parentheses). */
function unwrapExpression(node: unknown): unknown {
	let current = node as { readonly type?: string; readonly expression?: unknown } | undefined;
	while (
		current &&
		(current.type === 'TSAsExpression' ||
			current.type === 'TSSatisfiesExpression' ||
			current.type === 'TSNonNullExpression' ||
			current.type === 'ParenthesizedExpression')
	) {
		current = current.expression as typeof current;
	}
	return current;
}

/**
 * The dialect must be selected explicitly: `parseAstAsync` does not derive it
 * from the filename argument and otherwise parses in JS mode, rejecting
 * TypeScript-only syntax in agent modules.
 */
export function parserLangForFile(filePath: string): 'ts' | 'js' {
	return /\.(?:ts|mts|cts)$/.test(filePath) ? 'ts' : 'js';
}

async function scanAgentModuleFile(filePath: string): Promise<AgentModuleScan> {
	const code = await fs.promises.readFile(filePath, 'utf8');
	return scanAgentModuleCode(code, filePath);
}

function assertValidIdentities(results: readonly AgentScanResult[]): void {
	const invalidAgents = results
		.filter((result) => !AGENT_IDENTITY_PATTERN.test(result.identity))
		.map(({ identity, filePath }) => ({ identity, filePath }));
	if (invalidAgents.length > 0) throw new InvalidAgentIdentityError(invalidAgents);
}

function assertUniqueIdentities(results: readonly AgentScanResult[]): void {
	const byIdentity = new Map<string, string[]>();
	for (const result of results) {
		const filePaths = byIdentity.get(result.identity) ?? [];
		filePaths.push(`${result.filePath}#${result.exportName}`);
		byIdentity.set(result.identity, filePaths);
	}
	const duplicates = [...byIdentity]
		.filter(([, filePaths]) => filePaths.length > 1)
		.map(([identity, filePaths]) => ({ identity, filePaths }));
	if (duplicates.length > 0) throw new DuplicateAgentIdentityError(duplicates);
}

/**
 * Distinct identities must not fold to the same generated Durable Object
 * identifier: agentClassName()/agentBindingName() are lossy (case and
 * kebab/camel folding), and a collision emits the same `export const` twice
 * in the generated worker entry and duplicate wrangler DO bindings — cryptic
 * build failures with no pointer to the identity clash. Class and binding
 * names fold differently (`AB` and `Ab` share only a binding name), so each
 * is checked independently.
 */
function assertUniqueDurableIdentifiers(results: readonly AgentScanResult[]): void {
	const collisions: Array<{
		identifier: string;
		agents: Array<{ identity: string; filePath: string }>;
	}> = [];
	for (const key of ['className', 'bindingName'] as const) {
		const byIdentifier = new Map<string, AgentScanResult[]>();
		for (const result of results) {
			const group = byIdentifier.get(result[key]) ?? [];
			group.push(result);
			byIdentifier.set(result[key], group);
		}
		for (const [identifier, group] of byIdentifier) {
			// Same-identity duplicates were already rejected above; only distinct
			// identities folding together are collisions.
			if (new Set(group.map((result) => result.identity)).size < 2) continue;
			collisions.push({
				identifier,
				agents: group.map(({ identity, filePath }) => ({ identity, filePath })),
			});
		}
	}
	if (collisions.length > 0) throw new AgentIdentifierCollisionError(collisions);
}
