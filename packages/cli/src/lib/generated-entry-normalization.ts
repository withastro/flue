export function generateBuiltModuleNormalizationSource(): string {
	return `
function normalizeBuiltModules(agentModules, workflowModules) {
  const manifest = { agents: [], workflows: [] };
  const createdAgents = {};
  const dispatchAgentNames = new Map();
  const workflowHandlers = {};
  const localWorkflowHandlers = {};
  const agentRouteMiddleware = {};
  const workflowRouteMiddleware = {};
  for (const [name, mod] of Object.entries(agentModules)) {
    if (!mod.default || mod.default.__flueCreatedAgent !== true || typeof mod.default.initialize !== 'function') throw new Error('[flue] Agent "' + name + '" must default-export createAgent(...).');
    if (mod.route !== undefined && typeof mod.route !== 'function') throw new Error('[flue] Agent "' + name + '" route export must be a callable Hono middleware value.');
    const transports = {};
    if (typeof mod.route === 'function') transports.http = true;
    manifest.agents.push({ name, transports, created: true });
    createdAgents[name] = mod.default;
    const previousDispatchName = dispatchAgentNames.get(mod.default);
    if (previousDispatchName !== undefined) throw new Error('[flue] Agents "' + previousDispatchName + '" and "' + name + '" default-export the same created agent value. Use distinct createAgent(...) values for dispatchable agent modules.');
    dispatchAgentNames.set(mod.default, name);
    if (typeof mod.route === 'function') agentRouteMiddleware[name] = mod.route;
  }

  for (const [name, mod] of Object.entries(workflowModules)) {
    if (typeof mod.run !== 'function') throw new Error('[flue] Workflow "' + name + '" must export a callable run value.');
    if (mod.route !== undefined && typeof mod.route !== 'function') throw new Error('[flue] Workflow "' + name + '" route export must be a callable Hono middleware value.');
    const transports = {};
    if (typeof mod.route === 'function') transports.http = true;
    manifest.workflows.push({ name, transports });
    localWorkflowHandlers[name] = mod.run;
    if (transports.http) workflowHandlers[name] = mod.run;
    if (typeof mod.route === 'function') workflowRouteMiddleware[name] = mod.route;
  }

  return { manifest, createdAgents, dispatchAgentNames, workflowHandlers, localWorkflowHandlers, agentRouteMiddleware, workflowRouteMiddleware };
}

`;
}
