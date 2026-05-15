/** Deprecated compatibility stub for the removed virtual Cloudflare sandbox API. */

export interface VirtualSandboxOptions {
	prefix?: string;
}

const MIGRATION_DOC = 'docs/cloudflare-shell.md';

export function getVirtualSandbox(): never;
export function getVirtualSandbox(bucket: unknown, options?: VirtualSandboxOptions): never;
export function getVirtualSandbox(bucket?: unknown, _options?: VirtualSandboxOptions): never {
	if (bucket === undefined) {
		throw new Error(
			'[flue] getVirtualSandbox() has been removed. Flue\'s default in-memory sandbox is already ' +
				'what you wanted — omit the `sandbox` option from init() (or pass `false`) and you get it. ' +
				`See ${MIGRATION_DOC} for the full migration story.`,
		);
	}
	throw new Error(
		'[flue] getVirtualSandbox(bucket) has been removed. Its "mount the R2 bucket as the agent ' +
			'filesystem" framing was never accurate — @cloudflare/shell\'s Workspace is a SQLite-indexed ' +
			'filesystem, not an R2 mount, and bucket keys uploaded externally were invisible to it.\n\n' +
			'Migrate to getShellSandbox() + hydrateFromBucket(), which explicitly copies the bucket\'s ' +
			'objects into a durable Workspace before the agent runs:\n\n' +
			'  import {\n' +
			'    getShellSandbox,\n' +
			'    getDefaultWorkspace,\n' +
			'    hydrateFromBucket,\n' +
			'  } from \'@flue/runtime/cloudflare\';\n\n' +
			'  const workspace = getDefaultWorkspace();\n' +
			'  if (!(await workspace.exists(\'/.hydrated\'))) {\n' +
			'    await hydrateFromBucket(workspace, env.KNOWLEDGE_BASE);\n' +
			'    await workspace.writeFile(\'/.hydrated\', new Date().toISOString());\n' +
			'  }\n' +
			'  const harness = await init({\n' +
			'    sandbox: getShellSandbox({ workspace, loader: env.LOADER }),\n' +
			'    model: \'anthropic/claude-sonnet-4-6\',\n' +
			'  });\n\n' +
			'Requires a `worker_loaders` binding in wrangler.jsonc; see ' +
			`${MIGRATION_DOC} for the binding setup and the @cloudflare/sandbox + mountBucket alternative ` +
			'if your account doesn\'t have Worker Loader access.',
	);
}
