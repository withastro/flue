import {
	DEFAULT_BQ_EXPLORE_SCRIPT,
	DEFAULT_METABASE_CLI_SCRIPT,
	type AnalyticsToolConfig,
} from '../lib/tools.ts';
import { DEFAULT_MANIFEST_PATH } from '../lib/manifest.ts';

export type AgentSource = 'web' | 'slack' | 'cli';
export type CredentialMode = 'service_account' | 'user_oauth';

export interface ToolPolicy extends AnalyticsToolConfig {
	source: AgentSource;
	actor?: {
		userId?: string;
		email?: string;
	};
	conversationId?: string;
	runId?: string;
	credentials: {
		bigQueryMode: CredentialMode;
		googleDriveMode: CredentialMode;
	};
	permissions: {
		allowSensitiveBigQuery: boolean;
		allowMetabaseCreate: boolean;
		allowGoogleDriveWrite: boolean;
		allowContextWrite: boolean;
		allowWorkflowMutation: boolean;
	};
	limits: {
		maxBigQueryGb: number;
		maxSearchResults: number;
		maxToolCalls?: number;
	};
}

export function createToolPolicy(input: {
	source?: AgentSource;
	userId?: string;
	email?: string;
	conversationId?: string;
	runId?: string;
	maxGb?: number;
	allowMetabaseCreate?: boolean;
	allowGoogleDriveWrite?: boolean;
	allowWorkflowMutation?: boolean;
} = {}): ToolPolicy {
	const source = input.source ?? 'cli';
	const webCanUseUserCredentials = source === 'web';
	const maxBigQueryGb = input.maxGb ?? 1;

	return {
		source,
		actor: {
			userId: input.userId,
			email: input.email,
		},
		conversationId: input.conversationId,
		runId: input.runId,
		manifestPath: process.env.DBT_MANIFEST_PATH || DEFAULT_MANIFEST_PATH,
		bqExploreScript: process.env.BQ_EXPLORE_SCRIPT || DEFAULT_BQ_EXPLORE_SCRIPT,
		metabaseCliScript: process.env.METABASE_CLI_SCRIPT || DEFAULT_METABASE_CLI_SCRIPT,
		maxGb: maxBigQueryGb,
		allowMetabaseCreate: input.allowMetabaseCreate ?? false,
		allowGoogleDriveWrite: input.allowGoogleDriveWrite ?? (source !== 'slack'),
		credentials: {
			bigQueryMode: webCanUseUserCredentials ? 'user_oauth' : 'service_account',
			googleDriveMode: webCanUseUserCredentials ? 'user_oauth' : 'service_account',
		},
		permissions: {
			allowSensitiveBigQuery: webCanUseUserCredentials,
			allowMetabaseCreate: input.allowMetabaseCreate ?? false,
			allowGoogleDriveWrite: input.allowGoogleDriveWrite ?? (source !== 'slack'),
			allowContextWrite: source !== 'slack',
			allowWorkflowMutation: input.allowWorkflowMutation ?? (source !== 'slack'),
		},
		limits: {
			maxBigQueryGb,
			maxSearchResults: 10,
		},
	};
}
