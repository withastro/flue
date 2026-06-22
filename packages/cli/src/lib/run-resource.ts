import { discoverAgents, discoverWorkflows } from './build.ts';

export type RunResource =
	| { kind: 'agent'; name: string; filePath: string }
	| { kind: 'workflow'; name: string; filePath: string };

export function resolveRunResource(sourceRoot: string, selector: string): RunResource {
	const agents = discoverAgents(sourceRoot);
	const workflows = discoverWorkflows(sourceRoot);
	const available = [
		...agents.map((resource) => `agent:${resource.name}`),
		...workflows.map((resource) => `workflow:${resource.name}`),
	].sort();
	const qualified = parseQualifier(selector);
	const matches: RunResource[] = qualified
		? qualified.kind === 'agent'
			? agents
				.filter((resource) => resource.name === qualified.name)
				.map((resource) => ({ kind: 'agent', ...resource }))
			: workflows
				.filter((resource) => resource.name === qualified.name)
				.map((resource) => ({ kind: 'workflow', ...resource }))
		: [
				...agents
					.filter((resource) => resource.name === selector)
					.map((resource) => ({ kind: 'agent' as const, ...resource })),
				...workflows
					.filter((resource) => resource.name === selector)
					.map((resource) => ({ kind: 'workflow' as const, ...resource })),
			];

	if (matches.length === 1) return matches[0] as RunResource;
	if (matches.length > 1) {
		throw new Error(
			`[flue] Resource "${selector}" is ambiguous. Qualify it as agent:${selector} or workflow:${selector}.\n\n${availableResources(available)}`,
		);
	}
	throw new Error(`[flue] Resource "${selector}" not found.\n\n${availableResources(available)}`);
}

function parseQualifier(selector: string): { kind: RunResource['kind']; name: string } | undefined {
	if (selector.startsWith('agent:')) return { kind: 'agent', name: selector.slice('agent:'.length) };
	if (selector.startsWith('workflow:')) {
		return { kind: 'workflow', name: selector.slice('workflow:'.length) };
	}
	return undefined;
}

function availableResources(resources: string[]): string {
	return resources.length === 0
		? 'Available resources: (none)'
		: `Available resources:\n${resources.map((resource) => `  ${resource}`).join('\n')}`;
}
