import { type FlueContext } from '@flue/runtime';
import * as v from 'valibot';

import { localWithoutBuiltinTools } from '../lib/sandbox.ts';
import { explorerToolset } from '../toolsets/explorer.ts';
import { createToolPolicy } from '../tools/policy.ts';

export const triggers = { webhook: true };

const SourceSchema = v.picklist(['kb', 'manifest', 'bigquery', 'metabase', 'slack', 'drive', 'repo', 'jira']);

const PayloadSchema = v.object({
	query: v.string(),
	sources: v.optional(v.array(SourceSchema), ['manifest']),
	sessionName: v.optional(v.string(), 'default'),
	model: v.optional(v.string()),
	source: v.optional(v.picklist(['web', 'slack', 'cli']), 'cli'),
	userId: v.optional(v.string()),
	email: v.optional(v.string()),
	maxResultsPerSource: v.optional(v.number(), 5),
});

const EvidencePackSchema = v.object({
	summary: v.string(),
	findings: v.array(
		v.object({
			source: SourceSchema,
			title: v.string(),
			reference: v.string(),
			relevance: v.picklist(['low', 'medium', 'high']),
			excerpt: v.optional(v.string()),
		}),
	),
	gaps: v.array(v.string()),
});

export default async function ({ init, payload, id, runId }: FlueContext) {
	const parsed = v.parse(PayloadSchema, payload);
	const model = parsed.model || process.env.EXPLORER_MODEL || 'openai/gpt-4.1-mini';
	const policy = createToolPolicy({
		source: parsed.source,
		userId: parsed.userId,
		email: parsed.email,
		conversationId: parsed.sessionName || id,
		runId,
	});

	const harness = await init({
		sandbox: localWithoutBuiltinTools({ disableTaskTool: true }),
		model,
		role: 'explorer',
		tools: explorerToolset(policy),
	});
	const session = await harness.session(parsed.sessionName);

	const { data, usage } = await session.prompt(
		[
			'Mode: evidence_pack.',
			'Read read_source_catalog first and use it to explain source selection and source/tool gaps.',
			`Requested sources: ${parsed.sources.join(', ')}.`,
			`Maximum findings per source: ${parsed.maxResultsPerSource}.`,
			'Query:',
			parsed.query,
		].join('\n\n'),
		{ result: EvidencePackSchema },
	);

	return { evidence: data, model, usage };
}
