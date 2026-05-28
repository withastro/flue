import type { ToolDef } from '@flue/runtime';

import { createAnalyticsTools, createBigQueryValidationTools } from '../lib/tools.ts';
import { createArtifactPersistenceTools } from '../tools/persistence.ts';
import type { ToolPolicy } from '../tools/policy.ts';

export function analyticsToolset(policy: ToolPolicy): ToolDef[] {
	const config = {
		manifestPath: policy.manifestPath,
		bqExploreScript: policy.bqExploreScript,
		metabaseCliScript: policy.metabaseCliScript,
		maxGb: policy.limits.maxBigQueryGb,
		allowMetabaseCreate: policy.permissions.allowMetabaseCreate,
		credentials: {
			bigQueryMode: policy.credentials.bigQueryMode,
		},
	} as const;
	return [...createAnalyticsTools(config), ...createBigQueryValidationTools(config), ...createArtifactPersistenceTools(policy)];
}
