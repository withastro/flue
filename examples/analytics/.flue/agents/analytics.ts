import { type FlueContext } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import * as v from 'valibot';

import { analyticsToolset } from '../toolsets/analytics.ts';
import { explorerToolset } from '../toolsets/explorer.ts';
import { createToolPolicy } from '../tools/policy.ts';

export const triggers = { webhook: true };

const PayloadSchema = v.object({
	message: v.string(),
	sessionName: v.optional(v.string(), 'default'),
	maxGb: v.optional(v.number(), 1),
	allowMetabaseCreate: v.optional(v.boolean(), false),
	model: v.optional(v.string()),
	source: v.optional(v.picklist(['web', 'slack', 'cli']), 'cli'),
	userId: v.optional(v.string()),
	email: v.optional(v.string()),
});

export default async function ({ init, payload, id, runId }: FlueContext) {
	const parsed = v.parse(PayloadSchema, payload);
	const model = parsed.model || process.env.ANALYTICS_MODEL || 'openai/gpt-5.4';
	const policy = createToolPolicy({
		source: parsed.source,
		userId: parsed.userId,
		email: parsed.email,
		conversationId: parsed.sessionName || id,
		runId,
		maxGb: parsed.maxGb,
		allowMetabaseCreate: parsed.allowMetabaseCreate,
	});

	const harness = await init({
		sandbox: local(),
		model,
		role: 'analytics',
		tools: dedupeToolsByName([...analyticsToolset(policy), ...explorerToolset(policy)]),
	});
	const session = await harness.session(parsed.sessionName);

	const { text, usage } = await session.prompt(
		[
			'Mode: standalone_analytics.',
			`Default BigQuery dry-run limit: ${parsed.maxGb} GB.`,
			`Metabase creation enabled: ${parsed.allowMetabaseCreate ? 'yes' : 'no'}.`,
			'Request:',
			parsed.message,
		].join('\n\n'),
	);

	return { reply: text, model, usage };
}

function dedupeToolsByName<T extends { name: string }>(tools: T[]): T[] {
	const seen = new Set<string>();
	const result: T[] = [];
	for (const tool of tools) {
		if (seen.has(tool.name)) continue;
		seen.add(tool.name);
		result.push(tool);
	}
	return result;
}
