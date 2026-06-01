/** Cloudflare build plugin. Produces a Worker + DO entry point for workflow runs and agent interactions. */
import * as path from 'node:path';
import {
	assertSandboxPackageInstalled,
	detectSandboxBindings,
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

	/**
	 * Per-build cache of the user's wrangler config. Both `generateEntryPoint`
	 * and `additionalOutputs` need it (for sandbox detection + the merge), and
	 * a fresh `CloudflarePlugin` instance is constructed for each build (see
	 * `resolvePlugin` in build.ts), so the cache is implicitly scoped to a
	 * single build.
	 */
	private userConfigCache: Awaited<ReturnType<typeof readUserWranglerConfig>> | undefined;

	/**
	 * Read the user's wrangler config from `root`. The user's config always
	 * lives at the project root, regardless of where the build artifacts get
	 * written via `output`. We generate an internal merged Vite input config
	 * without modifying the user's source configuration.
	 */
	private async getUserConfig(root: string) {
		if (!this.userConfigCache) {
			this.userConfigCache = await readUserWranglerConfig(root);
		}
		return this.userConfigCache;
	}

	async generateEntryPoint(ctx: BuildContext): Promise<string> {
		const { agents, appEntry, workflows } = ctx;
		const runtimeVersion = JSON.stringify(ctx.runtimeVersion);
		if (ctx.options.providers?.includes('amazon-bedrock')) {
			throw new Error('[flue] Provider "amazon-bedrock" is supported only by the Node target.');
		}
		validateCloudflareAgentNames(ctx);

		const agentImports = agents
			.map((a, index) => {
				const varName = agentVarName(a.name, index);
				const filePath = a.filePath.replace(/\\/g, '/');
				return `import * as ${varName} from '${filePath}';`;
			})
			.join('\n');
		const agentModuleEntries = agents
			.map((a, index) => `  ${JSON.stringify(a.name)}: ${agentVarName(a.name, index)},`)
			.join('\n');
		const workflowImports = workflows
			.map((workflow, index) => {
				const varName = workflowVarName(workflow.name, index);
				const filePath = workflow.filePath.replace(/\\/g, '/');
				return `import * as ${varName} from '${filePath}';`;
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
				(agent) => `export class ${agentClassName(agent.name)} extends Agent {
  async onRequest(request) {
    return dispatchAgent(request, this, ${JSON.stringify(agent.name)}, directHandlers[${JSON.stringify(agent.name)}]);
  }

  async fetch(request) {
    if (isWebSocketUpgrade(request)) {
      await this.__unsafe_ensureInitialized();
      return acceptAgentSocket(request, this, ${JSON.stringify(agent.name)});
    }
    return super.fetch(request);
  }

  async webSocketMessage(socket, message) {
    if (isFlueSocket(socket, 'agent', ${JSON.stringify(agent.name)})) {
      await this.__unsafe_ensureInitialized();
      return messageAgentSocket(socket, message, this, ${JSON.stringify(agent.name)});
    }
    return super.webSocketMessage(socket, message);
  }

  async webSocketClose(socket, code, reason, wasClean) {
    if (isFlueSocket(socket, 'agent', ${JSON.stringify(agent.name)})) return closeFlueSocket(socket, code, reason);
    return super.webSocketClose(socket, code, reason, wasClean);
  }

  async webSocketError(socket, error) {
    if (isFlueSocket(socket, 'agent', ${JSON.stringify(agent.name)})) return closeFlueSocket(socket, 1011, 'WebSocket error');
    return super.webSocketError(socket, error);
  }

  async onFiberRecovered(ctx) {
    if (ctx.name === 'flue:dispatch') {
      return handleFlueDispatchRecovered(ctx, this, ${JSON.stringify(agent.name)});
    }
    if (ctx.name === 'flue:direct') {
      return handleFlueDirectRecovered(ctx, this, ${JSON.stringify(agent.name)});
    }
    if (typeof super.onFiberRecovered === 'function') {
      return super.onFiberRecovered(ctx);
    }
  }
}`,
			)
			.join('\n\n');

		const workflowClasses = workflows
			.map(
				(workflow) => `export class ${workflowClassName(workflow.name)} extends Agent {
  async onRequest(request) {
    return dispatchWorkflow(request, this, ${JSON.stringify(workflow.name)});
  }

  async fetch(request) {
    if (isWebSocketUpgrade(request)) {
      await this.__unsafe_ensureInitialized();
      return acceptWorkflowSocket(request, this, ${JSON.stringify(workflow.name)});
    }
    return super.fetch(request);
  }

  async webSocketMessage(socket, message) {
    if (isFlueSocket(socket, 'workflow', ${JSON.stringify(workflow.name)})) {
      await this.__unsafe_ensureInitialized();
      return messageWorkflowSocket(socket, message, this, ${JSON.stringify(workflow.name)});
    }
    return super.webSocketMessage(socket, message);
  }

  async webSocketClose(socket, code, reason, wasClean) {
    if (isFlueSocket(socket, 'workflow', ${JSON.stringify(workflow.name)})) return closeFlueSocket(socket, code, reason);
    return super.webSocketClose(socket, code, reason, wasClean);
  }

  async webSocketError(socket, error) {
    if (isFlueSocket(socket, 'workflow', ${JSON.stringify(workflow.name)})) return closeFlueSocket(socket, 1011, 'WebSocket error');
    return super.webSocketError(socket, error);
  }

  async onFiberRecovered(ctx) {
    if (ctx.name?.startsWith('flue:workflow:')) {
      return handleFlueWorkflowFiberRecovered(ctx, this, ${JSON.stringify(workflow.name)});
    }
    if (typeof super.onFiberRecovered === 'function') {
      return super.onFiberRecovered(ctx);
    }
  }
}`,
			)
			.join('\n\n');

		const agentClassMapEntries = agents
			.map(
				(agent) =>
					`  ${JSON.stringify(agent.name)}: ${JSON.stringify(agentClassName(agent.name))},`,
			)
			.join('\n');
		const workflowClassMapEntries = workflows
			.map(
				(workflow) =>
					`  ${JSON.stringify(workflow.name)}: ${JSON.stringify(workflowClassName(workflow.name))},`,
			)
			.join('\n');

		const { effectiveConfig } = await this.getUserConfig(ctx.root);
		const sandboxClassNames = detectSandboxBindings(effectiveConfig);
		const sandboxReExports = sandboxClassNames
			.map((name) => `export { Sandbox as ${name} } from '@cloudflare/sandbox';`)
			.join('\n');

		const userAppImport = appEntry ? `import userApp from '${appEntry.replace(/\\/g, '/')}';` : '';
		const packagedSkillsImport = `import { getPackagedSkills } from 'virtual:flue/packaged-skills';`;
		const packagedSkillsValue = 'getPackagedSkills()';
		const builtModuleNormalizationSource = generateBuiltModuleNormalizationSource();

		return `
// Auto-generated by flue (target: cloudflare)
${packagedSkillsImport}
import { env } from 'cloudflare:workers';
import { Agent, getAgentByName, routeAgentRequest } from 'agents';
import {
  Bash,
  InMemoryFs,
  createFlueContext,
  InMemorySessionStore,
  InMemoryRunStore,
  createDurableRunStore,
  createRunSubscriberRegistry,
  bashFactoryToSessionEnv,
  resolveModel,
  handleAgentRequest,
  handleWorkflowRequest,
  handleRunRouteRequest,
  validateAgentDispatchAdmission,
  assertCurrentDispatchInput,
  createDispatchAgentHandler,
  reserveDispatchAgentSession,
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
  connectCloudflareAgentWebSocket,
  connectCloudflareWorkflowWebSocket,
  messageCloudflareAgentWebSocket,
  messageCloudflareWorkflowWebSocket,
} from '@flue/runtime/cloudflare';
import { registerApiProvider, registerProvider } from '@flue/runtime';

${agentImports}
${workflowImports}
${userAppImport}

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
const { manifest, directHandlers, localAgentHandlers, createdAgents, dispatchAgentNames, websocketAgentHandlers, workflowHandlers, websocketWorkflowHandlers, agentRouteMiddleware, agentWebSocketMiddleware, workflowRouteMiddleware, workflowWebSocketMiddleware } = normalized;
const agentClassNames = {
${agentClassMapEntries}
};
const workflowClassNames = {
${workflowClassMapEntries}
};

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

// Fallback in-memory store (used if no DO storage is available).
const memoryStore = new InMemorySessionStore();
const memoryRunStore = new InMemoryRunStore();
const INTERNAL_DISPATCH_PATH = '/__flue/internal/dispatch';
const dispatchQueue = {
  async enqueue(input) {
    const binding = env?.[agentBindingNameFromAgentName(input.agent)];
    if (!binding) throw new Error('[flue] dispatch() target agent "' + input.agent + '" Durable Object binding is unavailable.');
    const stub = await getAgentByName(binding, input.id);
    const response = await stub.fetch(new Request('https://flue.invalid' + INTERNAL_DISPATCH_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }));
    if (!response.ok) throw new Error('[flue] dispatch() target agent "' + input.agent + '" rejected durable admission with status ' + response.status + '.');
    return response.json();
  },
};

// Module-scoped per-isolate registry; run ids isolate buckets across DOs.
const runSubscribers = createRunSubscriberRegistry();

// Create a DO-backed session store from the Durable Object's SQL storage.
function createDOStore(sql) {
  // Ensure the table exists
  sql.exec(
    'CREATE TABLE IF NOT EXISTS flue_sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)'
  );
  return {
    async save(id, data) {
      const json = JSON.stringify(data);
      sql.exec(
        'INSERT OR REPLACE INTO flue_sessions (id, data, updated_at) VALUES (?, ?, ?)',
        id, json, Date.now()
      );
    },
    async load(id) {
      const rows = sql.exec('SELECT data FROM flue_sessions WHERE id = ?', id).toArray();
      if (rows.length === 0) return null;
      return JSON.parse(rows[0].data);
    },
    async delete(id) {
      sql.exec('DELETE FROM flue_sessions WHERE id = ?', id);
    },
  };
}

function createContextForRequest(id, runId, payload, doInstance, req, initialEventIndex, dispatchId) {
  // Use DO SQLite storage by default, fall back to in-memory
  const defaultStore = doInstance?.ctx?.storage?.sql
    ? createDOStore(doInstance.ctx.storage.sql)
    : memoryStore;

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

function createRunStoreForRequest(doInstance) {
  return doInstance?.ctx?.storage?.sql
    ? createDurableRunStore(doInstance.ctx.storage.sql)
    : memoryRunStore;
}

function createRunRegistryForRequest(reqEnv) {
  return createCloudflareRunRegistry(reqEnv?.FLUE_REGISTRY);
}

/**
 * Convert an agent name (URL segment, lower-kebab-case) back to its
 * Durable Object binding name (PascalCase). This MUST match the
 * build-time \`agentClassName\` helper byte-for-byte — its source is
 * inlined directly below via .toString() so the two cannot drift.
 * Used by the main worker to resolve a named agent target back into a
 * DO stub without keeping its own (name -> class) map.
 */
const agentBindingNameFromAgentName = ${agentClassName.toString().replace(/agentClassName/g, 'agentBindingNameFromAgentName')};

/**
 * Per-workflow Durable Object binding name (e.g. "draft" → "FLUE_WORKFLOW_DRAFT").
 * Workflows have one DO instance per run, with the instanceId equal to the
 * runId. Inlined from \`workflowBindingName\` so it cannot drift.
 */
const workflowBindingNameFromWorkflowName = ${workflowBindingName.toString().replace(/workflowBindingName/g, 'workflowBindingNameFromWorkflowName')};

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

function assertAgentsDurabilityApi(doInstance, method) {
  if (typeof doInstance[method] !== 'function') {
		throw new Error(
			'[flue] The installed "agents" package does not provide the required Cloudflare Agents SDK method "' +
				method +
				'". Install or upgrade the "agents" package in your project.',
		);
	}
}

async function handleFlueDispatchRecovered(ctx, doInstance, agentName) {
  const input = ctx.metadata?.input;
  assertCurrentDispatchInput(input);
  if (!input || input.agent !== agentName || input.id !== doInstance.name) return { status: 'error', error: 'Dispatch recovery metadata is invalid.' };
  try {
    await processManagedAgentDispatch(input, doInstance, agentName, ctx.id);
    return { status: 'completed' };
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}

async function handleFlueDirectRecovered(ctx, doInstance, agentName) {
  const payload = ctx.snapshot?.payload;
  const handler = localAgentHandlers[agentName];
  if (!handler || !payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.message !== 'string') {
    console.error('[flue:direct-recovery]', { agentName, instanceId: doInstance.name, operation: 'retry', outcome: 'restart_failed' }, new Error('Direct agent recovery input is unavailable; retry was not attempted.'));
    return;
  }
  const identity = agentRuntimeIdentity(agentName);
  const request = new Request('https://flue.invalid/agents/' + encodeURIComponent(agentName) + '/' + encodeURIComponent(doInstance.name), { method: 'POST' });
  try {
    assertAgentsDurabilityApi(doInstance, 'runFiber');
    await doInstance.runFiber('flue:direct', async (fiberCtx) => {
      fiberCtx.stash({ payload });
      const directCtx = createContextForRequest(doInstance.name, undefined, payload, doInstance, request);
      return runWithInstanceContext(doInstance, identity, () => handler(directCtx));
    });
    console.info('[flue:direct-recovery]', { agentName, instanceId: doInstance.name, operation: 'retry', outcome: 'restart_completed' });
  } catch (error) {
    console.error('[flue:direct-recovery]', { agentName, instanceId: doInstance.name, operation: 'retry', outcome: 'restart_failed' }, error);
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
    runSubscribers,
    runRegistry: createRunRegistryForRequest(doInstance.env),
    createContext: (id_, recoveredRunId, payload, req, initialEventIndex) => createContextForRequest(id_, recoveredRunId, payload, doInstance, req, initialEventIndex),
  });
}

// ─── Per-DO Dispatch ───────────────────────────────────────────────────────

async function waitForEarlierManagedDispatch(doInstance, input, fiberId) {
  if (typeof doInstance.listFibers !== 'function') return;
  while (true) {
    const fibers = await doInstance.listFibers({ name: 'flue:dispatch' });
    for (const fiber of fibers) assertCurrentDispatchInput(fiber.metadata?.input);
    const current = fibers.find((fiber) => fiber.id === fiberId);
    if (!current) return;
    const blocked = fibers.some((fiber) => {
      if (fiber.id === fiberId || fiber.status === 'completed' || fiber.status === 'error' || fiber.status === 'aborted') return false;
      const other = fiber.metadata?.input;
      if (!other || other.agent !== input.agent || other.id !== input.id || other.session !== input.session) return false;
      return fiber.createdAt < current.createdAt || (fiber.createdAt === current.createdAt && fiber.id < fiberId);
    });
    if (!blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function processManagedAgentDispatch(input, doInstance, agentName, fiberId) {
  const agent = createdAgents[agentName];
  if (!agent) throw new Error('[flue] Dispatch target unavailable during durable processing.');
  await validateAgentDispatchAdmission({ input });
  const target = { agentName, instanceId: doInstance.name };
  await waitForEarlierManagedDispatch(doInstance, input, fiberId);
  const releaseSessionLock = await reserveDispatchAgentSession(target, input);
  const request = new Request('https://flue.invalid' + INTERNAL_DISPATCH_PATH, { method: 'POST' });
  try {
    const ctx = createContextForRequest(doInstance.name, undefined, input, doInstance, request, undefined, input.dispatchId);
    await runWithInstanceContext(doInstance, agentRuntimeIdentity(agentName), () => createDispatchAgentHandler(agent, input)(ctx));
  } finally {
    releaseSessionLock?.();
  }
}

async function assertNoPendingDispatchForDirectSession(doInstance, agentName, session) {
  if (typeof doInstance.listFibers !== 'function') return;
  const fibers = await doInstance.listFibers({ name: 'flue:dispatch' });
  for (const fiber of fibers) assertCurrentDispatchInput(fiber.metadata?.input);
  if (fibers.some((fiber) => {
    const input = fiber.metadata?.input;
    return fiber.status !== 'completed' && fiber.status !== 'error' && fiber.status !== 'aborted' && input?.agent === agentName && input.id === doInstance.name && input.session === session;
  })) {
    throw new Error('[flue] This agent session has pending dispatched input and cannot accept direct input yet.');
  }
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
    return handleRunRouteRequest({
      request,
      owner: { kind: 'workflow', workflowName, instanceId },
      runStore: createRunStoreForRequest(doInstance),
      runSubscribers,
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
      runSubscribers,
      runRegistry: createRunRegistryForRequest(doInstance.env),
      createContext: (id_, runId, payload, req, initialEventIndex, dispatchId) => createContextForRequest(id_, runId, payload, doInstance, req, initialEventIndex, dispatchId),
      startWorkflowAdmission: (runId, run) => {
        assertAgentsDurabilityApi(doInstance, 'runFiber');
        return doInstance.runFiber('flue:workflow:' + runId, () => runWithInstanceContext(doInstance, identity, run));
      },
    }));
}

async function dispatchAgent(request, doInstance, agentName, handler) {
  const id = doInstance.name; // DO room name set by routeAgentRequest
  if (isInternalDispatchRequest(request)) {
    const input = await request.json();
    assertCurrentDispatchInput(input);
    if (input.agent !== agentName || input.id !== id) return new Response('Invalid internal dispatch target.', { status: 400 });
    if (!createdAgents[agentName]) return new Response('Dispatch target unavailable.', { status: 404 });
    assertAgentsDurabilityApi(doInstance, 'startFiber');
    assertAgentsDurabilityApi(doInstance, 'inspectFiberByKey');
    const idempotencyKey = 'flue:dispatch:' + input.dispatchId;
    const prior = await doInstance.inspectFiberByKey(idempotencyKey);
    assertCurrentDispatchInput(prior?.metadata?.input);
    if (prior?.metadata?.input && JSON.stringify(prior.metadata.input) !== JSON.stringify(input)) {
      return new Response('Conflicting internal dispatch replay.', { status: 409 });
    }
    await doInstance.startFiber('flue:dispatch', async (fiberCtx) => processManagedAgentDispatch(input, doInstance, agentName, fiberCtx.id), {
      idempotencyKey,
      metadata: { input },
    });
    return Response.json({ dispatchId: input.dispatchId, acceptedAt: input.acceptedAt });
  }
  const payload = await request.clone().json().catch(() => null);
  const session = typeof payload?.session === 'string' && payload.session.trim() !== '' ? payload.session : 'default';
  await assertNoPendingDispatchForDirectSession(doInstance, agentName, session);
  const identity = agentRuntimeIdentity(agentName);
  return runWithInstanceContext(doInstance, identity, () => handleAgentRequest({
      request,
      agentName,
      id,
      handler,
      createContext: (id_, runId, payload, req, initialEventIndex, dispatchId) => createContextForRequest(id_, runId, payload, doInstance, req, initialEventIndex, dispatchId),
      runHandler: (ctx, h) => {
        assertAgentsDurabilityApi(doInstance, 'runFiber');
        return doInstance.runFiber('flue:direct', (fiberCtx) => {
          fiberCtx.stash({ payload: ctx.payload });
          return h(ctx);
        });
      },
    }));
}

function isWebSocketUpgrade(request) {
  return request.method === 'GET' && request.headers.get('upgrade')?.toLowerCase() === 'websocket';
}

function isFlueSocket(socket, target, name) {
  const attachment = socket.deserializeAttachment?.();
  return attachment?.version === 1 && attachment.target === target && attachment.name === name;
}

function closeFlueSocket(socket, code, reason) {
  if (code === 1005 || code === 1006 || code === 1015) return;
  try {
    socket.close(code, reason);
  } catch {
    return;
  }
}

function acceptAgentSocket(request, doInstance, agentName) {
  const handler = websocketAgentHandlers[agentName];
  if (!handler) return new Response(null, { status: 404 });
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  doInstance.ctx.acceptWebSocket(server);
  connectCloudflareAgentWebSocket(server, { name: agentName, id: doInstance.name, requestUrl: socketRequestUrl(request) });
  return new Response(null, { status: 101, webSocket: client });
}

function acceptWorkflowSocket(request, doInstance, workflowName) {
  const handler = websocketWorkflowHandlers[workflowName];
  if (!handler) return new Response(null, { status: 404 });
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  doInstance.ctx.acceptWebSocket(server);
  connectCloudflareWorkflowWebSocket(server, { name: workflowName, runId: doInstance.name, requestUrl: socketRequestUrl(request) });
  return new Response(null, { status: 101, webSocket: client });
}

async function messageAgentSocket(connection, message, doInstance, agentName) {
  const handler = websocketAgentHandlers[agentName];
  if (!handler) return;
  const identity = agentRuntimeIdentity(agentName);
  return runWithInstanceContext(doInstance, identity, () => messageCloudflareAgentWebSocket(connection, message, {
    name: agentName,
    id: doInstance.name,
    request: socketRequest(connection),
    handler,
    beforePrompt: (session) => assertNoPendingDispatchForDirectSession(doInstance, agentName, session),
    createContext: (id_, runId, payload, req) => createContextForRequest(id_, runId, payload, doInstance, req),
    runHandler: (ctx, h) => {
      assertAgentsDurabilityApi(doInstance, 'runFiber');
      return doInstance.runFiber('flue:direct', (fiberCtx) => {
        fiberCtx.stash({ payload: ctx.payload });
        return h(ctx);
      });
    },
  }));
}

async function messageWorkflowSocket(connection, message, doInstance, workflowName) {
  const handler = websocketWorkflowHandlers[workflowName];
  if (!handler) return;
  const identity = workflowRuntimeIdentity(workflowName);
  return runWithInstanceContext(doInstance, identity, () => messageCloudflareWorkflowWebSocket(connection, message, {
    name: workflowName,
    runId: doInstance.name,
    request: socketRequest(connection),
    handler,
    runStore: createRunStoreForRequest(doInstance),
    runSubscribers,
    runRegistry: createRunRegistryForRequest(doInstance.env),
    createContext: (id_, runId, payload, req) => createContextForRequest(id_, runId, payload, doInstance, req),
    startWorkflowAdmission: (runId, run) => {
      assertAgentsDurabilityApi(doInstance, 'runFiber');
      return doInstance.runFiber('flue:workflow:' + runId, () => runWithInstanceContext(doInstance, identity, run));
    },
  }));
}

function socketRequest(connection) {
  const attachment = connection.deserializeAttachment?.();
  return new Request(attachment?.requestUrl || 'https://flue.invalid/');
}

function socketRequestUrl(request) {
  const url = new URL(request.url);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function workflowRuntimeIdentity(workflowName) {
  return {
    bindingName: workflowBindingNameFromWorkflowName(workflowName),
    className: workflowClassNames[workflowName],
  };
}

function agentRuntimeIdentity(agentName) {
  return {
    bindingName: agentBindingNameFromAgentName(agentName),
    className: agentClassNames[agentName],
  };
}

function isInternalDispatchRequest(request) {
  return request.method === 'POST' && new URL(request.url).pathname === INTERNAL_DISPATCH_PATH;
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
  if (!child) return { action: 'get', runId };
  if (child === 'events') return { action: 'events', runId };
  if (child === 'stream') return { action: 'stream', runId };
  return null;
}

// ─── Per-Agent / Per-Workflow Durable Object Classes ──────────────────────

${agentClasses}
${workflowClasses}

export { FlueRegistry };

// ─── User-declared Sandbox re-exports ──────────────────────────────────────
// One line per DO binding in the user's wrangler.jsonc whose class_name
// ends with "Sandbox". Flue aliases the single \`Sandbox\` class shipped by
// \`@cloudflare/sandbox\` so each user-chosen class_name resolves at the
// bundle's top level. The binding + container image configuration is owned
// by the user's wrangler.jsonc.
${sandboxReExports}

// ─── Runtime seed ───────────────────────────────────────────────────────────

configureFlueRuntime({
  target: 'cloudflare',
  devMode: import.meta.env.DEV,
  runtimeVersion: ${runtimeVersion},
  manifest,
  handlers: directHandlers,
  dispatchQueue,
  resolveDispatchAgentName: (agent) => dispatchAgentNames.get(agent),
  workflowHandlers,
  agentRouteMiddleware,
  agentWebSocketMiddleware,
  workflowRouteMiddleware,
  workflowWebSocketMiddleware,
  routeAgentRequest: (request, env) => routeAgentRequest(request, env),
  routeWorkflowRequest: async (request, reqEnv, target) => {
    const bindingName = workflowBindingNameFromWorkflowName(target.workflowName);
    const binding = reqEnv?.[bindingName];
    if (!binding) return null;
    const stub = await getAgentByName(binding, target.instanceId);
    return stub.fetch(request);
  },
  createRunRegistryForRequest,
  routeRunRequest: async (request, reqEnv, target) => {
    if (target.kind !== 'workflow') return null;
    const bindingName = workflowBindingNameFromWorkflowName(target.workflowName);
    const binding = reqEnv?.[bindingName];
    if (!binding) return null;
    const stub = await getAgentByName(binding, target.instanceId);
    return stub.fetch(request);
  },
});

// ─── App composition ────────────────────────────────────────────────────────

${
	appEntry
		? `// User-supplied app.ts. Their default export owns the entire request
// pipeline — the worker just verifies a fetch method exists and pipes
// through. The default flue() handler is available for them to mount
// however they want; this file does not impose a composition.
const app = userApp;
if (!app || typeof app.fetch !== 'function') {
  throw new Error(
    '[flue] app.ts default export must be a Hono app or an object with a fetch(request, env, ctx) method.'
  );
}`
		: `// No app.ts: build the default app via @flue/runtime so the generated entry
// stays \`hono\`-free (users only need hono in their node_modules when
// they author their own app.ts). The default mounts \`flue()\` at root
// and renders canonical Flue envelopes for unmatched paths.
const app = createDefaultFlueApp();`
}

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
};
`;
	}

	async additionalOutputs(ctx: BuildContext): Promise<Record<string, string>> {
		const outputs: Record<string, string> = {};

		const flueBindings: Array<{ name: string; class_name: string }> = ctx.agents.map((agent) => {
			const className = agentClassName(agent.name);
			return { name: className, class_name: className };
		});

		// One DO binding/class per workflow, mirroring agents. The class name
		// is PascalCase + "Workflow" suffix to keep it lexically distinct from
		// agent classes when a project happens to define both an agent and a
		// workflow with the same name. The binding is namespaced under
		// FLUE_WORKFLOW_<NAME> so the Cloudflare Agents SDK's `routeAgentRequest`
		// can never accidentally route a public `/agents/<binding-kebab>/...`
		// URL into a workflow DO.
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
		} = await this.getUserConfig(ctx.root);
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

		// Detect user-declared Sandbox bindings and verify the @cloudflare/sandbox
		// package is available before the Vite build tries to resolve it. Log each
		// binding we've auto-wired so users can see what Flue did on their behalf.
		const sandboxClassNames = detectSandboxBindings(effectiveConfig);
		if (sandboxClassNames.length > 0) {
			assertSandboxPackageInstalled(sandboxClassNames, ctx.root);
			for (const className of sandboxClassNames) {
				console.log(
					`[flue] Auto-wiring DO binding "${className}" to @cloudflare/sandbox's Sandbox class.`,
				);
			}
		}

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

function validateCloudflareAgentNames(ctx: BuildContext): void {
	// Agents and workflows both materialize as per-definition Durable Object
	// classes and bindings, so both need to round-trip through the kebab-case
	// → PascalCase converter and through the FLUE_WORKFLOW_<NAME> binding
	// name. Validate together with a shared message.
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
			`Durable Object bindings route correctly. Invalid file(s): ${invalidList}. ` +
			`Rename them to match ${CLOUDFLARE_AGENT_NAME_PATTERN}.`,
	);
}

/**
 * Convert agent name to a PascalCase DO class name.
 * "hello" → "Hello", "with-cloudflare" → "WithCloudflare"
 *
 * routeAgentRequest() converts binding names to kebab-case for URL matching,
 * so "WithCloudflare" → "with-cloudflare" → URL /agents/with-cloudflare/:id
 */
function agentClassName(name: string): string {
	return name
		.split(/[-_]/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join('');
}

/**
 * Convert workflow name to a PascalCase DO class name with a "Workflow"
 * suffix. "draft" → "DraftWorkflow", "daily-report" → "DailyReportWorkflow".
 * Suffix avoids collisions when a project defines an agent and a workflow
 * with the same name.
 */
function workflowClassName(name: string): string {
	const base = name
		.split(/[-_]/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join('');
	return `${base}Workflow`;
}

/**
 * Convert workflow name to its Durable Object binding name.
 * "draft" → "FLUE_WORKFLOW_DRAFT", "daily-report" → "FLUE_WORKFLOW_DAILY_REPORT".
 *
 * Prefixed with FLUE_WORKFLOW_ so it is namespaced away from any user binding
 * and so the Cloudflare Agents SDK's `routeAgentRequest` (which kebab-cases
 * binding names into `/agents/<binding>/...` URLs) cannot conflict with the
 * public `/workflows/:name` route.
 */
function workflowBindingName(name: string): string {
	return `FLUE_WORKFLOW_${name.replace(/-/g, '_').toUpperCase()}`;
}
