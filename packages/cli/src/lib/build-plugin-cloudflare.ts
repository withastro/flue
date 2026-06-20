/** Cloudflare build plugin. Produces a Worker + DO entry point for workflow runs and agent interactions. */
import * as path from 'node:path';
import {
	type FlueAdditions,
	mergeFlueAdditions,
	readUserWranglerConfig,
	validateUserWranglerConfig,
} from './cloudflare-wrangler-merge.ts';
import {
	agentVarName,
	channelVarName,
	generateBuiltModuleNormalizationSource,
	workflowVarName,
} from './generated-entry-normalization.ts';
import { note } from './terminal.ts';
import type { BuildContext, BuildPlugin, ViteCloudflareInputs } from './types.ts';

export class CloudflarePlugin implements BuildPlugin {
	name = 'cloudflare';
	bundle: BuildPlugin['bundle'] = 'vite-cloudflare';
	entryFilename = '_entry.ts';

	async generateEntryPoint(ctx: BuildContext): Promise<string> {
		const { agents, appEntry, channels, cloudflareEntry, workflows } = ctx;
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
		const channelImports = channels
			.map((channel, index) => {
				const varName = channelVarName(channel.name, index);
				return `import * as ${varName} from ${JSON.stringify(channel.filePath.replace(/\\/g, '/'))};`;
			})
			.join('\n');
		const channelModuleEntries = channels
			.map(
				(channel, index) =>
					`  ${JSON.stringify(channel.name)}: ${channelVarName(channel.name, index)},`,
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

		const userAppImport = appEntry
			? `import userApp from ${JSON.stringify(appEntry.replace(/\\/g, '/'))};`
			: '';
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
  admitDetachedWorkflow,
  assertWorkflowDefinition,
  createFlueContext,
  createSqlRunStore,
  CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH,
  createCloudflareAgentRuntime,
  createSqlSessionStore,
   SqliteEventStreamStore,
  bashFactoryToSessionEnv,
  resolveModel,
  handleWorkflowRequest,
  handleRunRouteRequest,
  handleStreamRead,
  handleStreamHead,
  failRecoveredRun,
  generateWorkflowRunId,
  configureFlueRuntime,
  createDefaultFlueApp,
  hasRegisteredProvider,
} from '@flue/runtime/internal';
import {
  runWithCloudflareContext,
  getCloudflareAIBindingApiProvider,
  FlueRegistry,
  createCloudflareRunIndex,
  createCloudflareRunStore,
  resolveCloudflareExtension,
} from '@flue/runtime/cloudflare/internal';
import { registerApiProvider, registerProvider } from '@flue/runtime';

${agentImports}
${workflowImports}
${channelImports}
${userAppImport}
${userCloudflareImport}
${userCloudflareReExport}

// ─── Internal provider registrations ────────────────────────────────────────
// User \`app.ts\` imports are hoisted above this body, so a user-supplied
// \`registerProvider('cloudflare', ...)\` runs first; the guard below
// preserves it. The runtime routes registrations without an explicit
// \`gateway\` through Cloudflare's default AI Gateway.

registerApiProvider(getCloudflareAIBindingApiProvider());

if (!hasRegisteredProvider('cloudflare')) {
  registerProvider('cloudflare', {
    api: 'cloudflare-ai-binding',
    binding: env.AI,
  });
}

// ─── Config ─────────────────────────────────────────────────────────────────

const packagedSkills = ${packagedSkillsValue};

${builtModuleNormalizationSource}
const agentModules = {
${agentModuleEntries}
};
const workflowModules = {
${workflowModuleEntries}
};
const channelModules = {
${channelModuleEntries}
};
const normalized = normalizeBuiltModules(agentModules, workflowModules, channelModules);
const { manifest, agentDefinitions, dispatchAgentNames, workflows, workflowNames, agentRouteMiddleware, workflowRouteMiddleware, channelHandlers } = normalized;
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

const INTERNAL_DISPATCH_PATH = CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH;
const INTERNAL_WORKFLOW_INVOKE_PATH = '/_flue/internal/workflow-invoke';
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

function createContextForRequest(id, runId, doInstance, req, defaultStore, initialEventIndex, dispatchId) {
  return createFlueContext({
    id,
    runId,
    dispatchId,
    env: doInstance?.env ?? {},
    req,
    initialEventIndex,
    agentConfig: { packagedSkills, resolveModel },
    createDefaultEnv,
    defaultStore,
  });
}

function createAgentContextForRequest(executionStore, id, doInstance, req, initialEventIndex, dispatchId) {
  return createFlueContext({
    id,
    env: doInstance?.env ?? {},
    req,
    initialEventIndex,
    dispatchId,
    agentConfig: { packagedSkills, resolveModel },
    createDefaultEnv,
    defaultStore: executionStore.sessions,
    submissionStore: executionStore.submissions,
  });
}

function createWorkflowContextForRequest(id, runId, doInstance, req, initialEventIndex, dispatchId) {
  const defaultStore = createSqlSessionStore(doInstance.ctx.storage);
  return createContextForRequest(id, runId, doInstance, req, defaultStore, initialEventIndex, dispatchId);
}

function createRunStoreForRequest(doInstance) {
  // Composite run store: per-workflow-DO records plus the FlueRegistry
  // index DO for cross-deployment lookup/listing.
  const sql = doInstance?.ctx?.storage?.sql;
  if (!sql) {
    throw new Error('[flue] Durable Object SQLite storage is unavailable — cannot create the run store. Flue Durable Object classes require SQLite-backed storage.');
  }
  return createCloudflareRunStore(createSqlRunStore(sql), doInstance?.env?.FLUE_REGISTRY);
}

// Falls back to the worker-level env so ambient callers (the listRuns()/
// getRun() primitives, which have no request scope) reach the index too.
function createRunIndexForRequest(reqEnv) {
  return createCloudflareRunIndex((reqEnv ?? env)?.FLUE_REGISTRY);
}

async function fetchAgent(binding, instanceId, request) {
  return (await getAgentByName(binding, instanceId)).fetch(request);
}

function runWithInstanceContext(doInstance, identity, fn) {
  return runWithCloudflareContext(
    {
      env: doInstance.env,
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

const eventStreamStores = new WeakMap();

function createEventStreamStoreForInstance(doInstance) {
  const existing = eventStreamStores.get(doInstance);
  if (existing) return existing;
  const sql = doInstance?.ctx?.storage?.sql;
  if (!sql) {
    throw new Error('[flue] Durable Object SQLite storage is unavailable — cannot create the event stream store. Flue Durable Object classes require SQLite-backed storage.');
  }
  const store = new SqliteEventStreamStore(sql);
  eventStreamStores.set(doInstance, store);
  return store;
}

const cloudflareAgents = createCloudflareAgentRuntime({
  agentDefinitions,
  createContext: ({ executionStore, instance, request, initialEventIndex, dispatchId }) =>
    createAgentContextForRequest(executionStore, instance.name, instance, request, initialEventIndex, dispatchId),
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
    workflowName,
    id: interruptedRunId,
    runId: interruptedRunId,
    request: new Request('https://flue.invalid/workflows/' + encodeURIComponent(workflowName), { method: 'POST' }),
    error: new Error('Flue workflow execution was interrupted. Start a new workflow run explicitly if retry is appropriate.'),
    runStore,
    eventStreamStore: createEventStreamStoreForInstance(doInstance),
    createContext: (id_, recoveredRunId, req, initialEventIndex) => createWorkflowContextForRequest(id_, recoveredRunId, doInstance, req, initialEventIndex),
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
      const streamPath = 'runs/' + runRoute.runId;
      if (request.method === 'HEAD') return await handleStreamHead(store, streamPath);
      return handleStreamRead({ store, path: streamPath, request });
    }
    return handleRunRouteRequest({
      workflowName,
      runId: instanceId,
      runStore: createRunStoreForRequest(doInstance),
    });
  }

  const workflow = workflows[workflowName];
  if (!workflow) return null;
  const identity = workflowRuntimeIdentity(workflowName);
  if (request.method === 'POST' && new URL(request.url).pathname === INTERNAL_WORKFLOW_INVOKE_PATH) {
    const { input } = await request.json();
    return runWithInstanceContext(doInstance, identity, async () => {
      const receipt = await admitDetachedWorkflow({
        workflowName,
        runId: instanceId,
        workflow,
        input,
        request,
        runStore: createRunStoreForRequest(doInstance),
        eventStreamStore: createEventStreamStoreForInstance(doInstance),
        createContext: (id_, runId, req, initialEventIndex, dispatchId) => createWorkflowContextForRequest(id_, runId, doInstance, req, initialEventIndex, dispatchId),
        startWorkflowAdmission: (runId, run) => {
          assertAgentsDurabilityApi(doInstance, 'runFiber');
          return doInstance.runFiber('flue:workflow:' + runId, () => runWithInstanceContext(doInstance, identity, run));
        },
      });
      return new Response(JSON.stringify(receipt), { status: 202, headers: { 'content-type': 'application/json' } });
    });
  }
  if (!parseWorkflowStart(request, workflowName)) return null;
  return runWithInstanceContext(doInstance, identity, () => handleWorkflowRequest({
      request,
      workflowName,
      runId: instanceId,
      workflow,
      runStore: createRunStoreForRequest(doInstance),
      eventStreamStore: createEventStreamStoreForInstance(doInstance),
      createContext: (id_, runId, req, initialEventIndex, dispatchId) => createWorkflowContextForRequest(id_, runId, doInstance, req, initialEventIndex, dispatchId),
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
  const url = new URL(request.url);
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 2 || segments[0] !== 'runs') return null;
  let runId;
  try {
    runId = decodeURIComponent(segments[1] || '');
  } catch {
    return null;
  }
  if (!runId) return null;
  // GET /runs/:runId?meta → run-record view; GET/HEAD otherwise → DS
  // stream read. The outer worker rejects other methods before
  // forwarding, so nothing else routes here.
  if (request.method === 'GET' && url.searchParams.has('meta')) return { action: 'get', runId };
  if (request.method === 'GET' || request.method === 'HEAD') return { action: 'ds-stream', runId };
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
  resolveWorkflowName: (workflow) => workflowNames.get(workflow),
  admitWorkflow: async ({ workflowName, input }) => {
    const identity = workflowIdentities[workflowName];
    const binding = env?.[identity?.bindingName];
    if (!binding) throw new Error('[flue] invoke() target workflow Durable Object binding is unavailable.');
    const runId = generateWorkflowRunId();
    const response = await fetchAgent(binding, runId, new Request('https://flue.invalid' + INTERNAL_WORKFLOW_INVOKE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input }),
    }));
    if (!response.ok) throw new Error('[flue] invoke() target workflow rejected durable admission with status ' + response.status + '.');
    return response.json();
  },
  agentRouteMiddleware,
  workflowRouteMiddleware,
  channelHandlers,
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
  createRunIndexForRequest,
  routeRunRequest: async (request, reqEnv, target) => {
    // reqEnv is undefined for ambient callers (the getRun() primitive);
    // fall back to the worker-level env.
    const binding = (reqEnv ?? env)?.[workflowIdentities[target.workflowName]?.bindingName];
    if (!binding) return null;
    return fetchAgent(binding, target.runId, request);
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

	async viteInputs(ctx: BuildContext): Promise<ViteCloudflareInputs> {
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
			note(`wrangler ${userConfigPath}`);
		}
		validateUserWranglerConfig({ config: userConfig, effectiveConfig });

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
			merged.$schema = './node_modules/wrangler/config-schema.json';
		}

		// Flue no longer emits a Dockerfile. Users who use container sandboxes
		// provide their own Dockerfile at whatever path their wrangler.jsonc's
		// `containers[].image` points to.

		return { wranglerConfig: JSON.stringify(merged, null, 2) };
	}
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
