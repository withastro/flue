import type { ToolDef } from '@flue/runtime';

import {
	createBigQueryValidationTools,
	createExternalKnowledgeTools,
	createJiraAutomationTools,
	createManifestTools,
} from '../lib/tools.ts';
import { createWaiterDocsTools } from '../tools/waiter-docs.ts';
import type { ToolPolicy } from '../tools/policy.ts';

export function explorerToolset(policy: ToolPolicy): ToolDef[] {
	return [
		...createManifestTools({
			manifestPath: policy.manifestPath,
		}),
		...createWaiterDocsTools(),
		...createBigQueryValidationTools({
			maxGb: policy.limits.maxBigQueryGb,
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
