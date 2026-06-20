import { type AgentRouteHandler, defineAgent, defineTool } from '@flue/runtime';
import * as v from 'valibot';

export const route: AgentRouteHandler = async (_c, next) => next();

const getServiceStatus = defineTool({
	name: 'get_service_status',
	description: 'Look up the current operational status for a service.',
	parameters: v.object({ service: v.string() }),
	execute: async ({ service }) => `${service}: operational`,
});

export default defineAgent(() => ({
	model: 'anthropic/claude-haiku-4-5',
	instructions: 'Use the service status tool before answering questions about system health.',
	tools: [getServiceStatus],
}));
