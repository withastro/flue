/** Variable name for a generated-entry agent module import. */
export function agentVarName(name: string, index: number): string {
	return builtModuleVarName('handler', 'agent', name, index);
}

/** Variable name for a generated-entry workflow module import. */
export function workflowVarName(name: string, index: number): string {
	return builtModuleVarName('workflow', 'workflow', name, index);
}

/** Variable name for a generated-entry channel module import. */
export function channelVarName(name: string, index: number): string {
	return builtModuleVarName('channel', 'channel', name, index);
}

function builtModuleVarName(prefix: string, fallback: string, name: string, index: number): string {
	const readableName = name.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '') || fallback;
	return `${prefix}_${readableName}_${index}`;
}

export function generateBuiltModuleNormalizationSource(): string {
	return `
function normalizeBuiltModules(agentModules, workflowModules, channelModules = {}) {
  const agents = [];
  const workflows = [];
  const channelHandlers = {};
  for (const [name, mod] of Object.entries(agentModules)) {
    if (!mod.default || mod.default.__flueAgentDefinition !== true || typeof mod.default.initialize !== 'function') throw new Error('[flue] Agent "' + name + '" must default-export defineAgent(...).');
    if (mod.route !== undefined && typeof mod.route !== 'function') throw new Error('[flue] Agent "' + name + '" route export must be a callable Hono middleware value.');
    if (mod.attachments !== undefined && typeof mod.attachments !== 'function') throw new Error('[flue] Agent "' + name + '" attachments export must be a callable Hono middleware value.');
    if (mod.description !== undefined && (typeof mod.description !== 'string' || mod.description.trim().length === 0)) throw new Error('[flue] Agent "' + name + '" description export must be a non-empty string.');
    const previous = agents.find((agent) => agent.definition === mod.default);
    if (previous) throw new Error('[flue] Agents "' + previous.name + '" and "' + name + '" default-export the same agent definition value. Use distinct defineAgent(...) values for dispatchable agent modules.');
    const agent = { name, definition: mod.default };
    if (mod.description !== undefined) agent.description = mod.description;
    if (typeof mod.route === 'function') agent.route = mod.route;
    if (typeof mod.attachments === 'function') agent.attachments = mod.attachments;
    agents.push(agent);
  }

  for (const [name, mod] of Object.entries(workflowModules)) {
    assertWorkflowDefinition(mod.default, name);
    if (mod.route !== undefined && typeof mod.route !== 'function') throw new Error('[flue] Workflow "' + name + '" route export must be a callable Hono middleware value.');
    if (mod.runs !== undefined && typeof mod.runs !== 'function') throw new Error('[flue] Workflow "' + name + '" runs export must be a callable Hono middleware value.');
    const previous = workflows.find((workflow) => workflow.definition === mod.default);
    if (previous) throw new Error('[flue] Workflows "' + previous.name + '" and "' + name + '" default-export the same workflow definition value. Use distinct defineWorkflow(...) values for workflow modules.');
    const workflow = { name, definition: mod.default };
    if (typeof mod.route === 'function') workflow.route = mod.route;
    if (typeof mod.runs === 'function') workflow.runs = mod.runs;
    workflows.push(workflow);
  }

  for (const [name, mod] of Object.entries(channelModules)) {
    const channel = mod.channel;
    if (!channel || typeof channel !== 'object' || Array.isArray(channel)) throw new Error('[flue] Channel "' + name + '" must export a created channel as the named "channel" binding.');
    if (!Array.isArray(channel.routes) || channel.routes.length === 0) throw new Error('[flue] Channel "' + name + '" must declare at least one route.');
    const routes = {};
    for (const route of channel.routes) {
      if (!route || typeof route !== 'object' || Array.isArray(route)) throw new Error('[flue] Channel "' + name + '" contains an invalid route declaration.');
      if (typeof route.method !== 'string' || !/^[A-Z]+$/.test(route.method)) throw new Error('[flue] Channel "' + name + '" route method must contain only uppercase ASCII letters.');
      if (typeof route.path !== 'string' || route.path.length < 2 || !route.path.startsWith('/') || route.path.startsWith('//') || route.path.includes('?') || route.path.includes('#')) throw new Error('[flue] Channel "' + name + '" route path must be a non-empty absolute suffix without a query or fragment.');
      const segments = route.path.split('/');
      if (segments.some((segment) => segment === '.' || segment === '..')) throw new Error('[flue] Channel "' + name + '" route path must remain beneath its channel namespace.');
      if (typeof route.handler !== 'function') throw new Error('[flue] Channel "' + name + '" route handler must be callable.');
      const key = route.method + ' ' + route.path;
      if (routes[key] !== undefined) throw new Error('[flue] Channel "' + name + '" declares duplicate route "' + key + '".');
      routes[key] = route.handler;
    }
    channelHandlers[name] = routes;
  }

  return { agents, workflows, channelHandlers };
}

`;
}
