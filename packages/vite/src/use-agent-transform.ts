/**
 * The `"use agent"` module transform.
 *
 * For every agent of a scanned module (each exported capitalized function),
 * appends a call to `__flueBindAgentModule(agentFn, { identity })` — the
 * identity-binding contract defined by `@flue/runtime` (see
 * packages/runtime/src/runtime/registration.ts). The binding runs at
 * module-evaluation time, so `app.ts` can call `createAgentRouter(agent)`
 * during its own evaluation, before the generated bootstrap registers the
 * scanned set — and the identity rides as a build-time string literal, so
 * minified builds keep the durable identity intact.
 *
 * The appended code references the module's own namespace via a self-import,
 * which works for every export form (declaration, const initializer, named
 * default) without rewriting authored code.
 */
import MagicString from 'magic-string';
import { parseAstAsync } from 'vite';
import { findAgentDirectiveStatement, parserLangForFile } from './agent-scan.ts';

export interface UseAgentTransformResult {
	code: string;
	map: ReturnType<MagicString['generateMap']>;
}

export interface UseAgentTransformAgent {
	/** The export the agent function rides (`'default'` for default exports). */
	readonly exportName: string;
	/** The agent's scanned durable identity. */
	readonly identity: string;
}

/**
 * Transform an agent module (already known to be part of the scanned agent
 * set) by appending one identity-binding call per agent. Returns `null` when
 * the module's directive prologue does not actually declare `'use agent'`
 * (e.g. the marker text only appears in a string or comment).
 */
export async function transformUseAgentModule(options: {
	code: string;
	/** The Vite module id, used verbatim as the self-import specifier. */
	id: string;
	/** Filesystem path (id without query), for parser dialect detection. */
	filePath: string;
	/** The module's scanned agents. */
	agents: readonly UseAgentTransformAgent[];
}): Promise<UseAgentTransformResult | null> {
	const { code, id, filePath, agents } = options;
	const program = await parseAstAsync(code, { lang: parserLangForFile(filePath) }, filePath);
	const body = program.body as readonly unknown[];
	const directive = findAgentDirectiveStatement(body);
	if (!directive) return null;

	const bindings = agents.map(
		(agent) =>
			`__flue_bind_agent_module__(__flue_agent_module__[${JSON.stringify(agent.exportName)}], { identity: ${JSON.stringify(agent.identity)} });`,
	);

	const ms = new MagicString(code);
	ms.append(
		[
			'',
			'',
			'// Injected by @flue/vite ("use agent" identity binding).',
			`import { __flueBindAgentModule as __flue_bind_agent_module__ } from '@flue/runtime';`,
			`import * as __flue_agent_module__ from ${JSON.stringify(id)};`,
			...bindings,
			'',
		].join('\n'),
	);
	// `source` + `includeContent` keep the original module text in the emitted
	// map; without them Vite's sourcemap composition can drop the original
	// source and downstream consumers fall back to transformed code.
	return {
		code: ms.toString(),
		map: ms.generateMap({ hires: 'boundary', source: id, includeContent: true }),
	};
}
