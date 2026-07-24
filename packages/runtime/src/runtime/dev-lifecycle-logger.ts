import type { AgentSubmission } from '../agent-execution-store.ts';

export interface AgentInteractionStart {
	agentName: string;
	instanceId: string;
	kind: AgentSubmission['kind'];
	submissionId: string;
}

export function installDevLifecycleLogger(write: (message: string) => void = console.log): {
	onAgentInteractionStart(interaction: AgentInteractionStart): void;
	dispose(): void;
} {
	return {
		onAgentInteractionStart(interaction) {
			write(`[agent] ${interaction.agentName}@${interaction.instanceId} started`);
		},
		dispose() {},
	};
}
