import type { ToolDef } from '@flue/runtime';

import { analyticsToolset } from './analytics.ts';
import { createExternalKnowledgeTools, createJiraAutomationTools } from '../lib/tools.ts';
import {
	createContextPersistenceTools,
	createTracePersistenceTools,
	createWorkflowPersistenceTools,
} from '../tools/persistence.ts';
import { createKbTools } from '../tools/kb.ts';
import { createProjectSkillTools } from '../tools/project-skills.ts';
import { createWorkflowTemplateTools } from '../tools/workflow-templates.ts';
import type { ToolPolicy } from '../tools/policy.ts';
import { createSourceCatalogTools } from '../tools/source-catalog.ts';

export function dbtExplorerToolset(policy: ToolPolicy): ToolDef[] {
	return [
		...analyticsToolset(policy),
		...createSourceCatalogTools(),
		...createKbTools(),
		...createProjectSkillTools(),
		...createWorkflowTemplateTools(),
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
