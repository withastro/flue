/** Cloudflare build plugin. Produces a Worker + DO entry point for workflow runs and agent interactions. */
import * as path from 'node:path';
import {
	type FlueAdditions,
	mergeFlueAdditions,
	readUserWranglerConfig,
	validateUserWranglerConfig,
} from './cloudflare-wrangler-merge.ts';
import { generateBuiltModuleNormalizationSource } from './generated-entry-normalization.ts';
import type { BuildContext, BuildPlugin } from './types.ts';

export class CloudflarePlugin implements BuildPlugin {
	name = 'cloudflare';
	bundle: BuildPlugin['bundle'] = 'vite-cloudflare';
	entryFilename = '_entry.ts';

	async generateEntryPoint(ctx: BuildContext): Promise<string> {
		const { agents, appEntry, cloudflareEntry, workflows } = ctx;
		const runtimeVersion = JSON.stringify(ctx.runtimeVersion);
		validateCloudflareAgentNames(ctx);
		validateCloudflareExportNames(ctx);
		if (ctx.dbEntry) {
			throw new Error(
				`[flue] Custom persistence (db.ts) is not supported on the Cloudflare target. ` +
					`Cloudflare agents use Durable Object SQLite automatically. ` +
					`Remove the db.ts file or move it outside the source root.`,
			);
		}

		const agentImports = agents
			.map((a, index) => {
				const varName = agentVarName(a.name, index);
				return `import * as ${varName} from ${JSON.stringify(a.filePath.replace(/\\/g, '/'))};`;
			})
			.join('\n');
		const agentModuleEntries = agents
			.map((a, index) => `  ${JSON.stringify(a.name)}: ${agentVarName(a.name, index)},`)
			.join('\n');
		const workflowImports = workflows
			.map((workflow, index) => {
				const varName = workflowVarName(workflow.name, index);
				return `import * as ${varName} from ${JSON.stringify(workflow.filePath.replace(/\\/g, '/'))};`;
			})
			.join('\n');
		const workflowModuleEntries = workflows
			.map(
				(workflow, index) =>
					`  ${JSON.stringify(workflow.name)}: ${workflowVarName(workflow.name, index)},`,
			)
			.join('\n');

		const agentClasses = agents
			.map(
				(
					agent,
					index,
				) => `const agentExtension${index} = resolveCloudflareExtension(agentModules[${JSON.stringify(agent.name)}], ${JSON.stringify(agent.name)}, 'Agent');
const ${agentClassName(agent.name)} = class ${agentClassName(agent.name)} extends agentExtension${index}.base(Agent) {
  constructor(ctx, env) {
    const prepared = cloudflareAgents.prepare({ storage: ctx.storage, className: ${JSON.stringify(agentClassName(agent.name))}, agentName: ${JSON.stringify(agent.name)} });
    super(ctx, env);
    cloudflareAgents.attach(this, prepared);
  }

  onStart(props) {
    return cloudflareAgents.onStart(this, () => typeof super.onStart === 'function' ? super.onStart(props) : undefined);
  }

  __flueWakeAgentSubmissions() {
    return cloudflareAgents.wakeSubmissions(this);
  }

  onRequest(request) {
    return cloudflareAgents.onRequest(this, request);
  }

  onFiberRecovered(ctx) {
    return cloudflareAgents.onFiberRecovered(this, ctx, () => typeof super.onFiberRecovered === 'function' ? super.onFiberRecovered(ctx) : undefined);
  }
};
const Wrapped${agentClassName(agent.name)} = agentExtension${index}.wrap(${agentClassName(agent.name)});
export { Wrapped${agentClassName(agent.name)} as ${agentClassName(agent.name)} };`,
			)
			.join('\n\n');

		const workflowClasses = workflows
			.map(
				(
					workflow,
					index,
				) => `const workflowExtension${index} = resolveCloudflareExtension(workflowModules[${JSON.stringify(workflow.name)}], ${JSON.stringify(workflow.name)}, 'Workflow');
const ${workflowClassName(workflow.name)} = class ${workflowClassName(workflow.name)} extends workflowExtension${index}.base(Agent) {
  async onRequest(request) {
    return dispatchWorkflow(request, this, ${JSON.stringify(workflow.name)});
  }

  async onFiberRecovered(ctx) {
    if (ctx.name?.startsWith('flue:workflow:')) {
      return handleFlueWorkflowFiberRecovered(ctx, this, ${JSON.stringify(workflow.name)});
    }
    if (typeof super.onFiberRecovered === 'function') {
      return super.onFiberRecovered(ctx);
    }
  }
};
const Wrapped${workflowClassName(workflow.name)} = workflowExtension${index}.wrap(${workflowClassName(workflow.name)});
export { Wrapped${workflowClassName(workflow.name)} as ${workflowClassName(workflow.name)} };`,
			)
			.join('\n\n');

		const agentIdentityEntries = agents
			.map(
				(agent) =>
					`  ${JSON.stringify(agent.name)}: { bindingName: ${JSON.stringify(agentBindingName(agent.name))}, className: ${JSON.stringify(agentClassName(agent.name))} },`,
			)
			.join('\n');
		const workflowIdentityEntries = workflows
			.map(
				(workflow) =>
					`  ${JSON.stringify(workflow.name)}: { bindingName: ${JSON.stringify(workflowBindingName(workflow.name))}, className: ${JSON.stringify(workflowClassName(workflow.name))} },`,
			)
			.join('\n');

		const userAppImport = appEntry ? `import userApp from ${JSON.stringify(appEntry.replace(/\\/g, '/'))};` : '';
		const userCloudflareImport = cloudflareEntry
			? `import * as userCloudflareModule from ${JSON.stringify(cloudflareEntry.replace(/\\/g, '/'))};`
			: '';
		const userCloudflareReExport = cloudflareEntry
			? `export * from ${JSON.stringify(cloudflareEntry.replace(/\\/g, '/'))};`
			: '';
		const userCloudflareValue = cloudflareEntry ? 'userCloudflareModule' : '{}';
		const reservedCloudflareExportNames = [
			...agents.map((agent) => agentClassName(agent.name)),
			...workflows.map((workflow) => workflowClassName(workflow.name)),
			'FlueRegistry',
		];

		const packagedSkillsImport = `import { getPackagedSkills } from 'virtual:flue/packaged-skills';`;
		const packagedSkillsValue = 'getPackagedSkills()';
		const builtModuleNormalizationSource = generateBuiltModuleNormalizationSource();

		return `
// Auto-generated by flue (target: cloudflare)
${packagedSkillsImport}
import { env } from 'cloudflare:workers';
import { Agent, getAgentByName } from 'agents';
import {
  Bash,
  InMemoryFs,
  createFlueContext,
  InMemorySessionStore,
  InMemoryRunStore,
  createDurableRunStore,
  CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH,
  createCloudflareAgentRuntime,
  createSqlSessionStore,
   SqlEventStreamStore,
   ensureEventStreamTables,
  bashFactoryToSessionEnv,
  resolveModel,
  handleWorkflowRequest,
  handleRunRouteRequest,
  handleStreamRead,
  handleStreamHead,
  failRecoveredRun,
  configureFlueRuntime,
  createDefaultFlueApp,
  createDirectAgentHandler,
  hasRegisteredProvider,
} from '@flue/runtime/internal';
import {
  runWithCloudflareContext,
  cfSandboxToSessionEnv,
  getCloudflareAIBindingApiProvider,
  FlueRegistry,
  createCloudflareRunRegistry,
  resolveCloudflareExtension,
} from '@flue/runtime/cloudflare';
import { registerApiProvider, registerProvider } from '@flue/runtime';

${agentImports}
${workflowImports}
${userAppImport}
${userCloudflareImport}
${userCloudflareReExport}

// ─── Internal provider registrations ────────────────────────────────────────
// User \`app.ts\` imports are hoisted above this body, so a user-supplied
// \`registerProvider('cloudflare', ...)\` runs first; the guard below
// preserves it. The default enables Cloudflare's default AI Gateway,
// which the binding spins up on demand for the account.

registerApiProvider(getCloudflareAIBindingApiProvider());

if (!hasRegisteredProvider('cloudflare')) {
  registerProvider('cloudflare', {
    api: 'cloudflare-ai-binding',
    binding: env.AI,
    gateway: { id: 'default' },
  });
}

// ─── Config ─────────────────────────────────────────────────────────────────

const skills = {};
const packagedSkills = ${packagedSkillsValue};
const systemPrompt = '';

${builtModuleNormalizationSource}
const agentModules = {
${agentModuleEntries}
};
const workflowModules = {
${workflowModuleEntries}
};
const normalized = normalizeBuiltModules(agentModules, workflowModules);
const { manifest, directHandlers, createdAgents, dispatchAgentNames, workflowHandlers, agentRouteMiddleware, workflowRouteMiddleware } = normalized;
const agentIdentities = {
${agentIdentityEntries}
};
const workflowIdentities = {
${workflowIdentityEntries}
};

const userCloudflare = ${userCloudflareValue};
const reservedCloudflareExportNames = new Set(${JSON.stringify(reservedCloudflareExportNames)});
for (const name of Object.keys(userCloudflare)) {
  if (name === 'default') continue;
  if (reservedCloudflareExportNames.has(name)) {
    throw new Error('[flue] cloudflare.ts export "' + name + '" conflicts with a Flue-generated Worker export. Rename the authored export.');
  }
}
const cloudflareHandlers = 'default' in userCloudflare ? userCloudflare.default : {};
if (typeof cloudflareHandlers !== 'object' || cloudflareHandlers === null || Array.isArray(cloudflareHandlers)) {
  throw new Error('[flue] cloudflare.ts default export must be an object containing non-HTTP Worker handlers.');
}
if ('fetch' in cloudflareHandlers) {
  throw new Error('[flue] cloudflare.ts default export must not define fetch. Use app.ts for custom HTTP handling.');
}

// ─── Sandbox Environments ───────────────────────────────────────────────────

/**
 * Create an empty in-memory sandbox (default).
 */
async function createDefaultEnv() {
  const fs = new InMemoryFs();
  return bashFactoryToSessionEnv(() => new Bash({
    fs,
    network: { dangerouslyAllowFullInternetAccess: true },
  }));
}

/**
 * Detect and wrap external sandbox instances (e.g. from @cloudflare/sandbox's
 * getSandbox()). Returns SessionEnv if the value looks like a Durable Object
 * RPC stub, null otherwise.
 *
 * NOTE on detection: The value returned by \`getSandbox()\` is a workerd RPC
 * Proxy. None of the obvious detection strategies work:
 *
 *   - Structural duck-typing (\`'X' in stub\`, \`typeof stub.X === 'function'\`):
 *     the proxy lies positively for any property name, so any check returns
 *     \`true\` regardless of what's actually on the remote.
 *   - \`instanceof <UserSandboxClass>\` (e.g. \`Sandbox\` from
 *     \`@cloudflare/sandbox\`): the user's class only exists on the in-DO
 *     side; over RPC the caller gets a generic stub.
 *   - \`instanceof DurableObject\` (imported from \`cloudflare:workers\`): the
 *     stub's prototype chain has a class *named* \`DurableObject\`, but it's a
 *     workerd-internal class with a different identity than the importable
 *     one. \`instanceof\` checks identity, not name, so it returns \`false\`.
 *
 * The one signal that does work — verified by runtime probe — is the string
 * name of the prototype's constructor. Workerd's internal RPC stub class is
 * named \`DurableObject\`, and \`Object.getPrototypeOf(stub).constructor.name\`
 * returns that string. This is a heuristic (it relies on a workerd-internal
 * naming convention, not a contractual API), but it's empirically correct
 * today and will misroute only if a user passes some other DO stub to
 * \`createAgent(() => ({ sandbox }))\` — in which case \`cfSandboxToSessionEnv\` will fail
 * loudly on first method call.
 */
function resolveSandbox(sandbox) {
  if (
    sandbox &&
    typeof sandbox === 'object' &&
    Object.getPrototypeOf(sandbox)?.constructor?.name === 'DurableObject'
  ) {
    return cfSandboxToSessionEnv(sandbox);
  }
  return null;
}

const memoryWorkflowSessionStore = new InMemorySessionStore();
const memoryRunStore = new InMemoryRunStore();
const INTERNAL_DISPATCH_PATH = CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH;
const dispatchQueue = {
  async enqueue(input) {
    const identity = agentIdentities[input.agent];
    const binding = env?.[identity?.bindingName];
    if (!binding) throw new Error('[flue] dispatch() target agent "' + input.agent + '" Durable Object binding is unavailable.');
    const response = await fetchAgent(binding, input.id, new Request('https://flue.invalid' + INTERNAL_DISPATCH_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }));
    if (!response.ok) throw new Error('[flue] dispatch() target agent "' + input.agent + '" rejected durable admission with status ' + response.status + '.');
    return response.json();
  },
};

function createContextForRequest(id, runId, payload, doInstance, req, defaultStore, initialEventIndex, dispatchId) {
  return createFlueContext({
    id,
    runId,
    dispatchId,
    payload,
    env: doInstance?.env ?? {},
    req,
    initialEventIndex,
    agentConfig: {
      systemPrompt, skills, packagedSkills, model: undefined, resolveModel,
    },
    createDefaultEnv,
    defaultStore,
    resolveSandbox,
  });
}

function createAgentContextForRequest(executionStore, id, payload, doInstance, req, initialEventIndex, dispatchId) {
  return createFlueContext({
    id,
    payload,
    env: doInstance?.env ?? {},
    req,
    initialEventIndex,
    dispatchId,
    agentConfig: {
      systemPrompt, skills, packagedSkills, model: undefined, resolveModel,
    },
    createDefaultEnv,
    defaultStore: executionStore.sessions,
    resolveSandbox,
    submissionStore: executionStore.submissions,
  });
}

function createWorkflowContextForRequest(id, runId, payload, doInstance, req, initialEventIndex, dispatchId) {
  const sql = doInstance?.ctx?.storage?.sql;
  const defaultStore = sql ? createSqlSessionStore(sql) : memoryWorkflowSessionStore;
  return createContextForRequest(id, runId, payload, doInstance, req, defaultStore, initialEventIndex, dispatchId);
}

function createRunStoreForRequest(doInstance) {
  return doInstance?.ctx?.storage?.sql
    ? createDurableRunStore(doInstance.ctx.storage.sql)
    : memoryRunStore;
}

function createRunRegistryForRequest(reqEnv) {
  return createCloudflareRunRegistry(reqEnv?.FLUE_REGISTRY);
}

async function fetchAgent(binding, instanceId, request) {
  return (await getAgentByName(binding, instanceId)).fetch(request);
}

function runWithInstanceContext(doInstance, identity, fn) {
  return runWithCloudflareContext(
    {
      env: doInstance.env,
      agentInstance: doInstance,
      storage: doInstance.ctx.storage,
      durableObjectIdentity: createDurableObjectIdentity(doInstance, identity),
    },
    fn,
  );
}

function createDurableObjectIdentity(doInstance, identity) {
  return {
    bindingName: identity.bindingName,
    className: identity.className,
    name: doInstance.name,
    id: doInstance.ctx.id.toString(),
  };
}

function createEventStreamStoreForInstance(doInstance) {
  const sql = doInstance?.ctx?.storage?.sql;
  if (!sql) return undefined;
  ensureEventStreamTables(sql);
  return new SqlEventStreamStore(sql);
}

const cloudflareAgents = createCloudflareAgentRuntime({
  createdAgents,
  directHandlers,
  createContext: ({ executionStore, instance, payload, request, initialEventIndex, dispatchId }) =>
    createAgentContextForRequest(executionStore, instance.name, payload, instance, request, initialEventIndex, dispatchId),
  runWithInstanceContext: (instance, agentName, fn) => runWithInstanceContext(instance, agentRuntimeIdentity(agentName), fn),
  createEventStreamStore: (instance) => createEventStreamStoreForInstance(instance),
});

function assertAgentsDurabilityApi(doInstance, method) {
  if (typeof doInstance[method] !== 'function') {
		throw new Error(
			'[flue] The installed "agents" package does not provide the required Cloudflare Agents SDK method "' +
				method +
				'". Install or upgrade the "agents" package in your project.',
		);
	}
}

async function handleFlueWorkflowFiberRecovered(ctx, doInstance, workflowName) {
  if (!ctx.name || ctx.name !== 'flue:workflow:' + doInstance.name) return;
  const interruptedRunId = doInstance.name;
  const runStore = createRunStoreForRequest(doInstance);
  await failRecoveredRun({
    owner: { kind: 'workflow', workflowName, instanceId: interruptedRunId },
    id: interruptedRunId,
    runId: interruptedRunId,
    request: new Request('https://flue.invalid/workflows/' + encodeURIComponent(workflowName), { method: 'POST' }),
    error: new Error('Flue workflow execution was interrupted. Start a new workflow run explicitly if retry is appropriate.'),
    runStore,
    runRegistry: createRunRegistryForRequest(doInstance.env),
    eventStreamStore: createEventStreamStoreForInstance(doInstance),
    createContext: (id_, recoveredRunId, payload, req, initialEventIndex) => createWorkflowContextForRequest(id_, recoveredRunId, payload, doInstance, req, initialEventIndex),
  });
}

async function dispatchWorkflow(request, doInstance, workflowName) {
  // The DO room name is the workflow instance id. For workflows that
  // equals the run id (one run per instance), so callers reach this DO
  // either by starting a new run (POST /workflows/:name → routed by the
  // outer worker) or by hitting a /runs/:runId subroute on an existing
  // instance.
  const instanceId = doInstance.name;
  const runRoute = parseRunRoute(request);
  if (runRoute) {
    // DS stream read (GET/HEAD on /runs/:runId) — use EventStreamStore.
    if (runRoute.action === 'ds-stream') {
      const store = createEventStreamStoreForInstance(doInstance);
      if (!store) return new Response(null, { status: 404 });
      const streamPath = 'runs/' + runRoute.runId;
      if (request.method === 'HEAD') return handleStreamHead(store, streamPath);
      return handleStreamRead({ store, path: streamPath, request });
    }
    return handleRunRouteRequest({
      request,
      owner: { kind: 'workflow', workflowName, instanceId },
      runStore: createRunStoreForRequest(doInstance),
      ...runRoute,
    });
  }

  if (!parseWorkflowStart(request, workflowName)) return null;
  const handler = workflowHandlers[workflowName];
  if (!handler) return null;
  const identity = workflowRuntimeIdentity(workflowName);
  return runWithInstanceContext(doInstance, identity, () => handleWorkflowRequest({
      request,
      workflowName,
      runId: instanceId,
      handler,
      runStore: createRunStoreForRequest(doInstance),
      runRegistry: createRunRegistryForRequest(doInstance.env),
      eventStreamStore: createEventStreamStoreForInstance(doInstance),
      createContext: (id_, runId, payload, req, initialEventIndex, dispatchId) => createWorkflowContextForRequest(id_, runId, payload, doInstance, req, initialEventIndex, dispatchId),
      startWorkflowAdmission: (runId, run) => {
        assertAgentsDurabilityApi(doInstance, 'runFiber');
        return doInstance.runFiber('flue:workflow:' + runId, () => runWithInstanceContext(doInstance, identity, run));
      },
    }));
}



function workflowRuntimeIdentity(workflowName) {
  return workflowIdentities[workflowName];
}

function agentRuntimeIdentity(agentName) {
  return agentIdentities[agentName];
}

function parseWorkflowStart(request, workflowName) {
  if (request.method !== 'POST') return false;
  const url = new URL(request.url);
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 2 || segments[0] !== 'workflows') return false;
  return decodeURIComponent(segments[1] || '') === workflowName;
}

function parseRunRoute(request) {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  if (segments.length < 2 || segments[0] !== 'runs') return null;
  let runId;
  try {
    runId = decodeURIComponent(segments[1] || '');
  } catch {
    return null;
  }
  const child = segments[2];
  if (!runId) return null;
  if (!child) {
    const method = request.method;
    // GET/HEAD on /runs/:runId → DS stream read.
    if (method === 'GET' || method === 'HEAD') return { action: 'ds-stream', runId };
    return { action: 'get', runId };
  }
  return null;
}

// ─── Per-Agent / Per-Workflow Durable Object Classes ──────────────────────

${agentClasses}
${workflowClasses}

export { FlueRegistry };

// ─── Runtime seed ───────────────────────────────────────────────────────────

configureFlueRuntime({
  target: 'cloudflare',
  devMode: import.meta.env.DEV,
  runtimeVersion: ${runtimeVersion},
  manifest,
  dispatchQueue,
  resolveDispatchAgentName: (agent) => dispatchAgentNames.get(agent),
  agentRouteMiddleware,
  workflowRouteMiddleware,
  routeAgentRequest: async (request, reqEnv, target) => {
    const binding = reqEnv?.[agentIdentities[target.agentName]?.bindingName];
    if (!binding) return null;
    return fetchAgent(binding, target.instanceId, request);
  },
  routeWorkflowRequest: async (request, reqEnv, target) => {
    const binding = reqEnv?.[workflowIdentities[target.workflowName]?.bindingName];
    if (!binding) return null;
    return fetchAgent(binding, target.instanceId, request);
  },
  createRunRegistryForRequest,
  routeRunRequest: async (request, reqEnv, target) => {
    if (target.kind !== 'workflow') return null;
    const binding = reqEnv?.[workflowIdentities[target.workflowName]?.bindingName];
    if (!binding) return null;
    return fetchAgent(binding, target.instanceId, request);
  },
});

// ─── App composition ────────────────────────────────────────────────────────

${
	appEntry
		? `// User-supplied app.ts. Their default export owns the entire request
// pipeline — the worker just verifies a fetch method exists and pipes
// through. The default flue() handler is available for them to mount
// however they want; this file does not impose a composition.
const flueApp = userApp;
if (!flueApp || typeof flueApp.fetch !== 'function') {
  throw new Error(
    '[flue] app.ts default export must be a Hono app or an object with a fetch(request, env, ctx) method.'
  );
}`
		: `// No app.ts: build the default app via @flue/runtime so the generated entry
// stays \`hono\`-free (users only need hono in their node_modules when
// they author their own app.ts). The default mounts \`flue()\` at root
// and renders canonical Flue envelopes for unmatched paths.
const flueApp = createDefaultFlueApp();`
}

export default {
  ...cloudflareHandlers,
  fetch(request, env, ctx) {
    return flueApp.fetch(request, env, ctx);
  },
};
`;
	}

	async additionalOutputs(ctx: BuildContext): Promise<Record<string, string>> {
		const outputs: Record<string, string> = {};

		const flueBindings: Array<{ name: string; class_name: string }> = ctx.agents.map((agent) => ({
			name: agentBindingName(agent.name),
			class_name: agentClassName(agent.name),
		}));

		for (const workflow of ctx.workflows) {
			flueBindings.push({
				name: workflowBindingName(workflow.name),
				class_name: workflowClassName(workflow.name),
			});
		}

		const FLUE_REGISTRY_BINDING = { name: 'FLUE_REGISTRY', class_name: 'FlueRegistry' };
		flueBindings.push(FLUE_REGISTRY_BINDING);

		// Read and validate the user's wrangler config (if any). User's file
		// lives at the project root and is never modified; the composed Vite
		// input config is also written at the project root so official local
		// variable discovery continues to find `.dev.vars` and `.env` files.
		const {
			config: userConfig,
			effectiveConfig,
			path: userConfigPath,
		} = await readUserWranglerConfig(ctx.root);
		if (userConfigPath) {
			console.log(`[flue] Merging with user wrangler config: ${userConfigPath}`);
		}
		validateUserWranglerConfig(effectiveConfig);

		// Flue's contributions to the wrangler config. Everything else in the
		// user's wrangler.jsonc passes through untouched during merge.
		// `path.basename` rather than `split('/').pop()` so this works on
		// Windows too (native path separator there is `\`).
		const additions: FlueAdditions = {
			defaultName: path.basename(ctx.root) || 'flue-agents',
			main: '.flue-vite/_entry.ts',
			doBindings: flueBindings,
		};

		const merged = mergeFlueAdditions(userConfig, additions);

		// Always include the wrangler JSON schema reference if absent so the
		// generated file gets editor validation if someone opens it directly.
		if (typeof merged.$schema !== 'string') {
			merged.$schema = 'https://workers.cloudflare.com/schema/wrangler.json';
		}

		outputs['wrangler.jsonc'] = JSON.stringify(merged, null, 2);

		// Flue no longer emits a Dockerfile. Users who use container sandboxes
		// provide their own Dockerfile at whatever path their wrangler.jsonc's
		// `containers[].image` points to.

		return outputs;
	}
}

function agentVarName(name: string, index: number): string {
	const readableName = name.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '') || 'agent';
	return `handler_${readableName}_${index}`;
}

function workflowVarName(name: string, index: number): string {
	const readableName = name.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '') || 'workflow';
	return `workflow_${readableName}_${index}`;
}

const CLOUDFLARE_AGENT_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function validateCloudflareExportNames(ctx: BuildContext): void {
	const entries = [
		...ctx.agents.map((agent) => ({
			name: agentClassName(agent.name),
			source: `agent "${agent.name}"`,
		})),
		...ctx.workflows.map((workflow) => ({
			name: workflowClassName(workflow.name),
			source: `workflow "${workflow.name}"`,
		})),
		{ name: 'FlueRegistry', source: 'Flue registry' },
	];
	const sourcesByName = new Map<string, string[]>();
	for (const entry of entries) {
		const sources = sourcesByName.get(entry.name) ?? [];
		sources.push(entry.source);
		sourcesByName.set(entry.name, sources);
	}
	const conflicts = [...sourcesByName]
		.filter(([, sources]) => sources.length > 1)
		.map(([name, sources]) => `"${name}" (${sources.join(', ')})`)
		.join(', ');
	if (!conflicts) return;
	throw new Error(
		`[flue] Cloudflare target generated conflicting Worker export name(s): ${conflicts}. Rename the conflicting agent or workflow file.`,
	);
}

function validateCloudflareAgentNames(ctx: BuildContext): void {
	// Agents and workflows both materialize as per-definition Durable Object
	// classes and bindings, so both need predictable generated identifiers.
	// Validate together with a shared message.
	const invalidAgents = ctx.agents.filter(
		(agent) => !CLOUDFLARE_AGENT_NAME_PATTERN.test(agent.name),
	);
	const invalidWorkflows = ctx.workflows.filter(
		(workflow) => !CLOUDFLARE_AGENT_NAME_PATTERN.test(workflow.name),
	);
	if (invalidAgents.length === 0 && invalidWorkflows.length === 0) return;

	const invalidList = [
		...invalidAgents.map(
			(agent) => `${path.relative(ctx.root, agent.filePath)} (agent: ${agent.name})`,
		),
		...invalidWorkflows.map(
			(workflow) => `${path.relative(ctx.root, workflow.filePath)} (workflow: ${workflow.name})`,
		),
	].join(', ');

	throw new Error(
		`[flue] Cloudflare target requires agent and workflow filenames to use lower-kebab-case so ` +
			`generated Durable Object identifiers remain predictable. Invalid file(s): ${invalidList}. ` +
			`Rename them to match ${CLOUDFLARE_AGENT_NAME_PATTERN}.`,
	);
}

function agentClassName(name: string): string {
	return `Flue${pascalCaseName(name)}Agent`;
}

function workflowClassName(name: string): string {
	return `Flue${pascalCaseName(name)}Workflow`;
}

function agentBindingName(name: string): string {
	return `FLUE_${name.replace(/-/g, '_').toUpperCase()}_AGENT`;
}

function workflowBindingName(name: string): string {
	return `FLUE_${name.replace(/-/g, '_').toUpperCase()}_WORKFLOW`;
}

function pascalCaseName(name: string): string {
	return name
		.split(/[-_]/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join('');
}
