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
				(
					agent,
					index,
				) => `const agentExtension${index} = resolveCloudflareAgentExtension(agentModules[${JSON.stringify(agent.name)}], ${JSON.stringify(agent.name)});
const ${agentClassName(agent.name)} = class ${agentClassName(agent.name)} extends agentExtension${index}.base(Agent) {
  constructor(ctx, env) {
    const executionStore = createSqlAgentExecutionStore(ctx.storage, ${JSON.stringify(agentClassName(agent.name))});
    super(ctx, env);
    this[FLUE_AGENT_EXECUTION_STORE] = executionStore;
  }

  async onStart(props) {
    if (typeof super.onStart === 'function') await super.onStart(props);
    await reconcileFlueAgentSubmissions(this, ${JSON.stringify(agent.name)}, { preserveSuccessor: true });
  }

  async __flueWakeAgentSubmissions(wake) {
    await reconcileFlueAgentSubmissions(this, ${JSON.stringify(agent.name)}, { preserveSuccessor: true, executingWake: wake });
  }

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
};
const Wrapped${agentClassName(agent.name)} = agentExtension${index}.wrap(${agentClassName(agent.name)});
export { Wrapped${agentClassName(agent.name)} as ${agentClassName(agent.name)} };`,
			)
			.join('\n\n');

		const workflowClasses = workflows
			.map(
				(workflow) => `class ${workflowClassName(workflow.name)} extends Agent {
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
};
export { ${workflowClassName(workflow.name)} };`,
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

		const userAppImport = appEntry ? `import userApp from '${appEntry.replace(/\\/g, '/')}';` : '';
		const userCloudflareImport = cloudflareEntry
			? `import * as userCloudflareModule from '${cloudflareEntry.replace(/\\/g, '/')}';`
			: '';
		const userCloudflareReExport = cloudflareEntry
			? `export * from '${cloudflareEntry.replace(/\\/g, '/')}';`
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
  createSqlAgentExecutionStore,
  createSqlSessionStore,
  SqlAgentSubmissionConflictError,
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
  resolveCloudflareAgentExtension,
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
const { manifest, directHandlers, localAgentHandlers, createdAgents, dispatchAgentNames, websocketAgentHandlers, workflowHandlers, websocketWorkflowHandlers, agentRouteMiddleware, agentWebSocketMiddleware, workflowRouteMiddleware, workflowWebSocketMiddleware } = normalized;
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
const FLUE_AGENT_EXECUTION_STORE = Symbol('flueAgentExecutionStore');
const FLUE_AGENT_SUBMISSION_WAKE_CALLBACK = '__flueWakeAgentSubmissions';
const FLUE_AGENT_SUBMISSION_RETRY_SECONDS = 30;
const INTERNAL_DISPATCH_PATH = '/__flue/internal/dispatch';
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

// Module-scoped per-isolate registry; run ids isolate buckets across DOs.
const runSubscribers = createRunSubscriberRegistry();

function getAgentExecutionStore(doInstance) {
  const store = doInstance[FLUE_AGENT_EXECUTION_STORE];
  if (!store) throw new Error('[flue] Generated Cloudflare agent execution store was not initialized.');
  return store;
}

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

function createAgentContextForRequest(id, payload, doInstance, req, initialEventIndex, dispatchId) {
  return createContextForRequest(
    id,
    undefined,
    payload,
    doInstance,
    req,
    getAgentExecutionStore(doInstance).sessions,
    initialEventIndex,
    dispatchId,
  );
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
  const submissions = getAgentExecutionStore(doInstance).submissions;
  const submission = submissions.getDispatch(input.dispatchId);
  if (submission && submission.status !== 'queued') return { status: submission.status === 'completed' ? 'completed' : 'error', error: submission.error };
  try {
    await processManagedAgentDispatch(submission ?? { input }, doInstance, agentName, ctx.id);
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
      const directCtx = createAgentContextForRequest(doInstance.name, payload, doInstance, request);
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
    createContext: (id_, recoveredRunId, payload, req, initialEventIndex) => createWorkflowContextForRequest(id_, recoveredRunId, payload, doInstance, req, initialEventIndex),
  });
}

// ─── Per-DO Dispatch ───────────────────────────────────────────────────────

function armFlueAgentSubmissionWake(doInstance, options = {}) {
  assertAgentsDurabilityApi(doInstance, 'schedule');
  return doInstance.schedule(
    options.delaySeconds ?? 0,
    FLUE_AGENT_SUBMISSION_WAKE_CALLBACK,
    { generation: options.generation ?? 0 },
    { idempotent: true },
  );
}

function armFlueAgentSubmissionAdmissionWakes(doInstance) {
  return Promise.all([
    armFlueAgentSubmissionWake(doInstance, { generation: 0 }),
    armFlueAgentSubmissionWake(doInstance, { generation: 1 }),
  ]);
}

async function reconcileFlueAgentSubmissions(doInstance, agentName, options = {}) {
  const submissions = getAgentExecutionStore(doInstance).submissions;
  if (!submissions.hasQueuedDispatches()) return;
  if (options.preserveSuccessor) {
    if (options.executingWake) {
      await armFlueAgentSubmissionWake(doInstance, {
        delaySeconds: FLUE_AGENT_SUBMISSION_RETRY_SECONDS,
        generation: options.executingWake.generation === 0 ? 1 : 0,
      });
    } else {
      await Promise.all([
        armFlueAgentSubmissionWake(doInstance, { delaySeconds: FLUE_AGENT_SUBMISSION_RETRY_SECONDS, generation: 0 }),
        armFlueAgentSubmissionWake(doInstance, { delaySeconds: FLUE_AGENT_SUBMISSION_RETRY_SECONDS, generation: 1 }),
      ]);
    }
  }
  try {
    while (true) {
      const runnable = submissions.listRunnableDispatches();
      let repairedTerminal = false;
      for (const submission of runnable) {
        if (await ensureManagedDispatchFiber(submission, doInstance, agentName)) repairedTerminal = true;
      }
      if (!repairedTerminal) break;
    }
  } catch (error) {
    console.error('[flue:dispatch-reconciliation]', { agentName, instanceId: doInstance.name, operation: 'reconcile', outcome: 'deferred_to_scheduled_wake' }, error);
    return;
  }
}

async function ensureManagedDispatchFiber(submission, doInstance, agentName) {
  assertAgentsDurabilityApi(doInstance, 'inspectFiberByKey');
  assertAgentsDurabilityApi(doInstance, 'startFiber');
  const idempotencyKey = 'flue:dispatch:' + submission.submissionId;
  const prior = await doInstance.inspectFiberByKey(idempotencyKey);
  if (prior) {
    try {
      await validateAgentDispatchAdmission({ input: prior.metadata?.input });
    } catch {
      getAgentExecutionStore(doInstance).submissions.failDispatch(submission.submissionId, new Error('[flue] Persisted dispatch Fiber metadata is malformed.'));
      return true;
    }
    if (JSON.stringify(prior.metadata.input) !== JSON.stringify(submission.input)) {
      getAgentExecutionStore(doInstance).submissions.failDispatch(submission.submissionId, new Error('[flue] Persisted dispatch Fiber conflicts with SQL submission.'));
      return true;
    }
  }
  if (prior?.status === 'completed') {
    getAgentExecutionStore(doInstance).submissions.completeDispatch(submission.submissionId);
    return true;
  }
  if (prior?.status === 'error' || prior?.status === 'aborted' || prior?.status === 'interrupted') {
    getAgentExecutionStore(doInstance).submissions.failDispatch(submission.submissionId, prior.error ?? 'Managed dispatch Fiber did not complete.');
    return true;
  }
  if (prior) return false;
  await doInstance.startFiber('flue:dispatch', async (fiberCtx) => processManagedAgentDispatch(submission, doInstance, agentName, fiberCtx.id), {
    idempotencyKey,
    metadata: { input: submission.input, submissionSequence: submission.sequence },
  });
  return false;
}

function isPersistedDispatchInput(input) {
  return !!input && typeof input === 'object' && !Array.isArray(input) &&
    typeof input.dispatchId === 'string' && input.dispatchId.trim() !== '' &&
    typeof input.agent === 'string' && input.agent.trim() !== '' &&
    typeof input.id === 'string' && input.id.trim() !== '' &&
    typeof input.session === 'string' && input.session.trim() !== '' &&
    input.input !== undefined && typeof input.acceptedAt === 'string' && input.acceptedAt.trim() !== '';
}

function listActiveLegacyManagedDispatches(doInstance) {
  const rows = doInstance.ctx.storage.sql.exec(
    'SELECT fiber_id, metadata_json, created_at FROM cf_agents_fibers ' +
    "WHERE name = 'flue:dispatch' AND (status IN ('pending', 'running') OR " +
    "(status = 'interrupted' AND EXISTS (SELECT 1 FROM cf_agents_runs WHERE id = fiber_id))) " +
    'ORDER BY created_at ASC, fiber_id ASC',
  ).toArray();
  return rows.flatMap((row) => {
    if (typeof row.fiber_id !== 'string' || typeof row.created_at !== 'number') {
      throw new Error('[flue] Persisted dispatch Fiber row is malformed.');
    }
    let metadata;
    try {
      metadata = typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : null;
    } catch {
      throw new Error('[flue] Persisted dispatch Fiber metadata is malformed.');
    }
    if (typeof metadata?.submissionSequence === 'number') return [];
    const input = metadata?.input;
    assertCurrentDispatchInput(input);
    if (!isPersistedDispatchInput(input)) throw new Error('[flue] Persisted dispatch Fiber metadata is malformed.');
    return [{ fiberId: row.fiber_id, createdAt: row.created_at, input }];
  });
}

async function waitForEarlierLegacyManagedDispatch(doInstance, input, fiberId) {
  while (true) {
    const fibers = listActiveLegacyManagedDispatches(doInstance);
    const current = fibers.find((fiber) => fiber.fiberId === fiberId);
    const blocked = fibers.some((fiber) => {
      if (fiber.fiberId === fiberId) return false;
      const other = fiber.input;
      if (other.agent !== input.agent || other.id !== input.id || other.session !== input.session) return false;
      if (!current) return true;
      return fiber.createdAt < current.createdAt || (fiber.createdAt === current.createdAt && fiber.fiberId < current.fiberId);
    });
    if (!blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function processManagedAgentDispatch(submission, doInstance, agentName, fiberId) {
  const input = submission.input;
  const submissions = getAgentExecutionStore(doInstance).submissions;
  const persisted = submissions.getDispatch(input.dispatchId);
  if (persisted && persisted.status !== 'queued') return;
  const agent = createdAgents[agentName];
  if (!agent) throw new Error('[flue] Dispatch target unavailable during durable processing.');
  await validateAgentDispatchAdmission({ input });
  const target = { agentName, instanceId: doInstance.name };
  if (typeof submission.sequence === 'number') {
    while (submissions.hasEarlierQueuedDispatch(submission)) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await waitForEarlierLegacyManagedDispatch(doInstance, input, fiberId);
  const releaseSessionLock = await reserveDispatchAgentSession(target, input);
  const request = new Request('https://flue.invalid' + INTERNAL_DISPATCH_PATH, { method: 'POST' });
  try {
    const ctx = createAgentContextForRequest(doInstance.name, input, doInstance, request, undefined, input.dispatchId);
    await runWithInstanceContext(doInstance, agentRuntimeIdentity(agentName), () => createDispatchAgentHandler(agent, input)(ctx));
    if (persisted) submissions.completeDispatch(input.dispatchId);
  } catch (error) {
    if (persisted) submissions.failDispatch(input.dispatchId, error);
    throw error;
  } finally {
    releaseSessionLock?.();
    if (persisted) void reconcileFlueAgentSubmissions(doInstance, agentName, { preserveSuccessor: true }).catch((error) => {
      console.error('[flue:dispatch-reconciliation]', { agentName, instanceId: doInstance.name, operation: 'settlement', outcome: 'reconcile_failed' }, error);
    });
  }
}

async function assertNoLegacyPendingDispatchFiberForDirectSession(doInstance, agentName, session) {
  const fibers = listActiveLegacyManagedDispatches(doInstance);
  if (fibers.some((fiber) => {
    const input = fiber.input;
    return input.agent === agentName && input.id === doInstance.name && input.session === session;
  })) {
    throw new Error('[flue] This agent session has pending dispatched input and cannot accept direct input yet.');
  }
}

async function assertNoPendingDispatchForDirectSession(doInstance, agentName, session) {
  if (getAgentExecutionStore(doInstance).submissions.hasQueuedDispatchForSession(doInstance.name, session)) {
    throw new Error('[flue] This agent session has pending dispatched input and cannot accept direct input yet.');
  }
  await assertNoLegacyPendingDispatchFiberForDirectSession(doInstance, agentName, session);
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
      createContext: (id_, runId, payload, req, initialEventIndex, dispatchId) => createWorkflowContextForRequest(id_, runId, payload, doInstance, req, initialEventIndex, dispatchId),
      startWorkflowAdmission: (runId, run) => {
        assertAgentsDurabilityApi(doInstance, 'runFiber');
        return doInstance.runFiber('flue:workflow:' + runId, () => runWithInstanceContext(doInstance, identity, run));
      },
    }));
}

async function dispatchAgent(request, doInstance, agentName, handler) {
  const id = doInstance.name;
  if (isInternalDispatchRequest(request)) {
    const input = await request.json();
    assertCurrentDispatchInput(input);
    if (input.agent !== agentName || input.id !== id) return new Response('Invalid internal dispatch target.', { status: 400 });
    if (!createdAgents[agentName]) return new Response('Dispatch target unavailable.', { status: 404 });
    await validateAgentDispatchAdmission({ input });
    await armFlueAgentSubmissionAdmissionWakes(doInstance);
    let submission;
    try {
      submission = getAgentExecutionStore(doInstance).submissions.admitDispatch(input);
    } catch (error) {
      if (error instanceof SqlAgentSubmissionConflictError) return new Response('Conflicting internal dispatch replay.', { status: 409 });
      throw error;
    }
    await reconcileFlueAgentSubmissions(doInstance, agentName);
    return Response.json({ dispatchId: submission.submissionId, acceptedAt: submission.input.acceptedAt });
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
      createContext: (id_, runId, payload, req, initialEventIndex, dispatchId) => createAgentContextForRequest(id_, payload, doInstance, req, initialEventIndex, dispatchId),
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
    createContext: (id_, runId, payload, req) => createAgentContextForRequest(id_, payload, doInstance, req),
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
    createContext: (id_, runId, payload, req) => createWorkflowContextForRequest(id_, runId, payload, doInstance, req),
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
  return workflowIdentities[workflowName];
}

function agentRuntimeIdentity(agentName) {
  return agentIdentities[agentName];
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
  ...cloudflareHandlers,
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
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
