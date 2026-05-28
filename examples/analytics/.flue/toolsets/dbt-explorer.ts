import type { ToolDef } from '@flue/runtime';

import { analyticsToolset } from './analytics.ts';
import { createExternalKnowledgeTools, createJiraAutomationTools } from '../lib/tools.ts';
import {
	createContextPersistenceTools,
	createTracePersistenceTools,
	createWorkflowPersistenceTools,
} from '../tools/persistence.ts';
import { createWaiterDocsTools } from '../tools/waiter-docs.ts';
import type { ToolPolicy } from '../tools/policy.ts';

export function dbtExplorerToolset(policy: ToolPolicy): ToolDef[] {
	return [
		...analyticsToolset(policy),
		...createWaiterDocsTools(),
		...createExternalKnowledgeTools({
			allowGoogleDriveWrite: policy.permissions.allowGoogleDriveWrite,
			limits: {
				maxSearchResults: policy.limits.maxSearchResults,
			},
		}),
		...createJiraAutomationTools({
			allowWorkflowMutation: policy.permissions.allowWorkflowMutation,
		}),
		...createContextPersistenceTools(policy),
		...createWorkflowPersistenceTools(policy),
		...createTracePersistenceTools(),
	];
}
