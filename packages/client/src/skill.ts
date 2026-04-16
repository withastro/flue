import type { OpencodeClient, Part } from '@opencode-ai/sdk';
import type * as v from 'valibot';
import { SkillOutputError } from './errors.ts';
import { buildResultExtractionPrompt, buildSkillPrompt } from './prompt.ts';
import { extractResult } from './result.ts';
import type { PromptOptions, SkillOptions } from './types.ts';

/** How often to poll and log progress (ms). */
const POLL_INTERVAL = 15_000;

/** Max times we'll see 0 assistant messages before giving up. */
const MAX_EMPTY_POLLS = 20; // 20 polls * 15s = 5 minutes

/** Default max time to poll before timing out (ms) - 60 minutes. */
const DEFAULT_POLL_TIMEOUT = 60 * 60 * 1000;

/**
 * Low-level primitive: send a fully-formed prompt to OpenCode, poll until
 * idle, and optionally extract a typed result.
 *
 * Both `flu.prompt()` and `flu.skill()` delegate to this function after
 * constructing their own prompt text.
 */
export async function runPrompt<S extends v.GenericSchema | undefined = undefined>(
	client: OpencodeClient,
	workdir: string,
	label: string,
	prompt: string,
	options?: PromptOptions<S>,
	debug?: boolean,
): Promise<S extends v.GenericSchema ? v.InferOutput<S> : void> {
	const { result: schema, agent, model, timeout } = options ?? {};
	console.log(`[flue] ${label}: starting`);
	console.log(`[flue] ${label}: creating session`);
	const session = await client.session.create({
		body: { title: label },
		query: { directory: workdir },
	});
	if (debug)
		console.log(`[flue] ${label}: session created`, {
			hasData: !!session.data,
			sessionId: session.data?.id,
			error: session.error,
		});

	if (!session.data) {
		throw new Error(`Failed to create OpenCode session for "${label}".`);
	}

	const sessionId = session.data.id;

	try {
		const promptStart = Date.now();

		if (debug) console.log(`[flue] ${label}: sending prompt async`);
		const asyncResult = await client.session.promptAsync({
			path: { id: sessionId },
			query: { directory: workdir },
			body: {
				agent: agent || 'build',
				...(model ? { model } : {}),
				parts: [{ type: 'text', text: prompt }],
			},
		});

		if (debug)
			console.log(`[flue] ${label}: prompt sent`, {
				hasError: !!asyncResult.error,
				error: asyncResult.error,
				data: asyncResult.data,
			});

		if (asyncResult.error) {
			throw new Error(
				`Failed to send prompt for "${label}" (session ${sessionId}): ${JSON.stringify(asyncResult.error)}`,
			);
		}

		// Confirm the session actually started processing
		await confirmSessionStarted(client, sessionId, workdir, label, debug);

		if (debug) console.log(`[flue] ${label}: starting polling`);
		const parts = await pollUntilIdle(
			client,
			sessionId,
			workdir,
			label,
			promptStart,
			timeout,
			debug,
		);
		const promptElapsed = ((Date.now() - promptStart) / 1000).toFixed(1);

		if (debug) console.log(`[flue] ${label}: completed (${promptElapsed}s)`);

		if (!schema) {
			return undefined as S extends v.GenericSchema ? v.InferOutput<S> : undefined;
		}

		try {
			return extractResult(
				parts,
				schema as v.GenericSchema,
				sessionId,
				debug,
			) as S extends v.GenericSchema ? v.InferOutput<S> : undefined;
		} catch (error) {
			if (!(error instanceof SkillOutputError)) throw error;
			if (!error.message.includes('---RESULT_START---')) throw error;
			// The LLM forgot to include the RESULT_START/RESULT_END block.
			// Send a follow-up message in the same session to ask for the result
			// while the format instructions are fresh in context.
				console.log(
					`[flue] ${label}: result extraction failed, sending follow-up prompt to request result`,
				);

			const followUpResult = await client.session.promptAsync({
				path: { id: sessionId },
				query: { directory: workdir },
				body: {
					agent: agent || 'build',
					...(model ? { model } : {}),
					parts: [
						{
							type: 'text',
							text: buildResultExtractionPrompt(schema as v.GenericSchema),
						},
					],
				},
			});

			if (followUpResult.error) {
				if (followUpResult.error instanceof Error) {
					followUpResult.error.cause = error;
				}
				throw followUpResult.error;
			}

			await confirmSessionStarted(client, sessionId, workdir, label, debug);
			const allParts = await pollUntilIdle(
				client,
				sessionId,
				workdir,
				label,
				Date.now(),
				timeout,
				debug,
			);

			return extractResult(
				allParts,
				schema as v.GenericSchema,
				sessionId,
				debug,
			) as S extends v.GenericSchema ? v.InferOutput<S> : undefined;
		}
	} finally {
		// Clean up the session to free server resources. Without this,
		// workflows that call prompt/skill in a loop (e.g. re-rating all
		// open issues) accumulate orphaned sessions and eventually OOM.
		try {
			await client.session.delete({
				path: { id: sessionId },
				query: { directory: workdir },
			});
		} catch {
			// Session cleanup is best-effort — don't mask the real error.
		}
	}
}

/**
 * Run a named skill: builds the skill prompt from the name + args + schema,
 * then delegates to runPrompt().
 */
export async function runSkill<S extends v.GenericSchema | undefined = undefined>(
	client: OpencodeClient,
	workdir: string,
	name: string,
	options?: SkillOptions<S>,
	proxyInstructions?: string[],
	debug?: boolean,
): Promise<S extends v.GenericSchema ? v.InferOutput<S> : void> {
	const { args, result: schema, model, timeout } = options ?? {};
	const prompt = buildSkillPrompt(
		name,
		args,
		schema as v.GenericSchema | undefined,
		proxyInstructions,
	);
	return runPrompt(
		client,
		workdir,
		`skill("${name}")`,
		prompt,
		{ result: schema, model, timeout },
		debug,
	);
}

/**
 * After promptAsync, confirm that OpenCode actually started processing the session.
 * Polls quickly (1s) to detect the session appearing as "busy" or a user message being recorded.
 * Fails fast (~15s) instead of letting the poll loop run for 5 minutes.
 */
async function confirmSessionStarted(
	client: OpencodeClient,
	sessionId: string,
	workdir: string,
	label: string,
	debug?: boolean,
): Promise<void> {
	const maxAttempts = 15; // 15 * 1s = 15s
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		await sleep(1_000);

		// Check if session appears in status (busy means it's running)
		const statusResult = await client.session.status({ query: { directory: workdir } });
		const sessionStatus = statusResult.data?.[sessionId];
		if (sessionStatus?.type === 'busy') {
			if (debug) console.log(`[flue] ${label}: session confirmed running`);
			return;
		}

		// Check if at least a user message was recorded (prompt was accepted)
		const messagesResult = await client.session.messages({
			path: { id: sessionId },
			query: { directory: workdir },
		});
		const messages = messagesResult.data as Array<{ info: { role: string } }> | undefined;
		if (messages && messages.length > 0) {
			if (debug) console.log(`[flue] ${label}: session confirmed (${messages.length} messages)`);
			return;
		}
	}

	throw new Error(
		`"${label}" failed to start: session ${sessionId} has no messages after 15s.\n` +
			`The prompt was accepted but OpenCode never began processing it.\n` +
			`This usually means no model is configured. Pass --model to the flue CLI or set "model" in opencode.json.`,
	);
}

async function pollUntilIdle(
	client: OpencodeClient,
	sessionId: string,
	workdir: string,
	label: string,
	startTime: number,
	timeout?: number,
	debug?: boolean,
): Promise<Part[]> {
	const maxPollTime = timeout ?? DEFAULT_POLL_TIMEOUT;
	let emptyPolls = 0;
	let pollCount = 0;

	for (;;) {
		await sleep(POLL_INTERVAL);
		pollCount++;

		const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

		if (Date.now() - startTime > maxPollTime) {
			throw new Error(
				`"${label}" timed out after ${elapsed}s. Session never went idle. This may indicate a stuck session or OpenCode bug.`,
			);
		}

		const statusResult = await client.session.status({ query: { directory: workdir } });
		const sessionStatus = statusResult.data?.[sessionId];

		if (!sessionStatus || sessionStatus.type === 'idle') {
			const parts = await fetchAllAssistantParts(client, sessionId, workdir);

			if (parts.length === 0) {
				emptyPolls++;
				// Log every ~60s while waiting for first output
				if (emptyPolls % 4 === 0) {
					console.log(
						`[flue] ${label}: status result: ${JSON.stringify({ hasData: !!statusResult.data, sessionIds: statusResult.data ? Object.keys(statusResult.data) : [], error: statusResult.error })}`,
					);
					console.log(
						`[flue] ${label}: sessionStatus for ${sessionId}: ${JSON.stringify(sessionStatus)}`,
					);
				}
				if (emptyPolls >= MAX_EMPTY_POLLS) {
					// Dump diagnostic info before failing
					const allMessages = await client.session.messages({
						path: { id: sessionId },
						query: { directory: workdir },
					});
					console.error(
						`[flue] ${label}: TIMEOUT DIAGNOSTICS`,
						JSON.stringify(
							{
								sessionId,
								statusData: statusResult.data,
								messageCount: Array.isArray(allMessages.data) ? allMessages.data.length : 0,
								messages: allMessages.data,
							},
							null,
							2,
						),
					);
					throw new Error(
						`"${label}" produced no output after ${elapsed}s and ${emptyPolls} empty polls. ` +
							`The agent may have failed to start — check model ID and API key.`,
					);
				}
				continue;
			}

			return parts;
		}

		// Log every ~60s while session is running
		if (pollCount % 4 === 0) {
			console.log(`[flue] ${label}: running (${elapsed}s)`);
		}
	}
}

/**
 * Fetch ALL parts from every assistant message in the session.
 */
async function fetchAllAssistantParts(
	client: OpencodeClient,
	sessionId: string,
	workdir: string,
): Promise<Part[]> {
	const messagesResult = await client.session.messages({
		path: { id: sessionId },
		query: { directory: workdir },
	});

	if (!messagesResult.data) {
		throw new Error(`Failed to fetch messages for session ${sessionId}.`);
	}

	const messages = messagesResult.data as Array<{ info: { role: string }; parts?: Part[] }>;
	const assistantMessages = messages.filter((m) => m.info.role === 'assistant');

	const allParts: Part[] = [];
	for (const msg of assistantMessages) {
		allParts.push(...(msg.parts ?? []));
	}

	return allParts;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
