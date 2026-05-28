import { type FlueContext } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import * as v from 'valibot';

import { loadDbtSkillInstructions } from '../lib/dbt-skill.ts';
import { dbtExplorerToolset } from '../toolsets/dbt-explorer.ts';
import { createToolPolicy } from '../tools/policy.ts';

export const triggers = { webhook: true };

const PayloadSchema = v.object({
	message: v.string(),
	sessionName: v.optional(v.string(), 'default'),
	source: v.optional(v.picklist(['web', 'slack', 'cli']), 'cli'),
	userId: v.optional(v.string()),
	email: v.optional(v.string()),
	maxGb: v.optional(v.number(), 1),
	allowMetabaseCreate: v.optional(v.boolean(), true),
	allowGoogleDriveWrite: v.optional(v.boolean(), true),
	allowWorkflowMutation: v.optional(v.boolean(), true),
	model: v.optional(v.string()),
});

const DbtExplorerResultSchema = v.object({
	reply: v.string(),
	mode: v.picklist(['consultation', 'development', 'documentation', 'metabase', 'gdrive', 'slack', 'unknown']),
	confidence: v.picklist(['low', 'medium', 'high']),
	needsFollowup: v.boolean(),
	followupQuestion: v.optional(v.string()),
	artifacts: v.array(
		v.object({
			type: v.picklist(['sql', 'csv', 'metabase_card', 'doc_update', 'research_note']),
			id: v.optional(v.string()),
			path: v.optional(v.string()),
			url: v.optional(v.string()),
			summary: v.optional(v.string()),
		}),
	),
	researchSummary: v.string(),
	caveats: v.array(v.string()),
});

export default async function ({ init, payload, id, runId }: FlueContext) {
	const parsed = v.parse(PayloadSchema, payload);
	const model = parsed.model || process.env.DBT_EXPLORER_MODEL || 'openai/gpt-5.4';
	const policy = createToolPolicy({
		source: parsed.source,
		userId: parsed.userId,
		email: parsed.email,
		conversationId: parsed.sessionName || id,
		runId,
		maxGb: parsed.maxGb,
		allowMetabaseCreate: parsed.allowMetabaseCreate,
		allowGoogleDriveWrite: parsed.allowGoogleDriveWrite,
		allowWorkflowMutation: parsed.allowWorkflowMutation,
	});
	const dbtSkill = await loadDbtSkillInstructions();

	const harness = await init({
		name: 'dbt-explorer',
		sandbox: local(),
		model,
		role: 'dbt-explorer',
		tools: dbtExplorerToolset(policy),
	});
	const session = await harness.session(parsed.sessionName);

	const { data, usage } = await session.prompt(
		[
			'Mode: omnipotent_baseline.',
			`Default BigQuery dry-run limit: ${parsed.maxGb} GB.`,
			`Metabase creation enabled: ${parsed.allowMetabaseCreate ? 'yes' : 'no'}.`,
			`Google Drive writes enabled: ${parsed.allowGoogleDriveWrite ? 'yes' : 'no'}.`,
			`Workflow mutation enabled: ${parsed.allowWorkflowMutation ? 'yes' : 'no'}.`,
			'Current dbt skill instructions:',
			dbtSkill,
			'User request:',
			parsed.message,
		].join('\n\n'),
		{ result: DbtExplorerResultSchema },
	);

	return {
		reply: data.reply,
		model,
		result: data,
		usage,
	};
}
