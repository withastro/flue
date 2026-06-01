import type { ToolDef } from '@flue/runtime';

import {
	createBigQueryValidationTools,
	createExternalKnowledgeTools,
	createJiraAutomationTools,
	createManifestTools,
	createMetabaseReadTools,
} from '../lib/tools.ts';
import { createKbTools } from '../tools/kb.ts';
import { createProjectSkillTools } from '../tools/project-skills.ts';
import type { ToolPolicy } from '../tools/policy.ts';
import { createSourceCatalogTools } from '../tools/source-catalog.ts';

export function explorerToolset(policy: ToolPolicy): ToolDef[] {
	return [
		...createManifestTools({
			manifestPath: policy.manifestPath,
		}),
		...createSourceCatalogTools(),
		...createKbTools(),
		...createProjectSkillTools(),
		...createBigQueryValidationTools({
			maxGb: policy.limits.maxBigQueryGb,
			credentials: {
				bigQueryMode: policy.credentials.bigQueryMode,
			},
		}),
		...createMetabaseReadTools({
			metabaseCliScript: policy.metabaseCliScript,
			credentials: {
				bigQueryMode: policy.credentials.bigQueryMode,
			},
		}),
		...createExternalKnowledgeTools({
			allowGoogleDriveWrite: false,
			limits: {
				maxSearchResults: policy.limits.maxSearchResults,
			},
		}),
		...createJiraAutomationTools({
			allowWorkflowMutation: false,
		}),
	];
}
