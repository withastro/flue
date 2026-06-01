import type { Plugin } from 'vite';

export const BUILT_IN_PROVIDERS = [
	'amazon-bedrock',
	'anthropic',
	'azure-openai-responses',
	'cerebras',
	'cloudflare-ai-gateway',
	'cloudflare-workers-ai',
	'deepseek',
	'fireworks',
	'github-copilot',
	'google',
	'google-vertex',
	'groq',
	'huggingface',
	'kimi-coding',
	'minimax',
	'minimax-cn',
	'mistral',
	'moonshotai',
	'moonshotai-cn',
	'openai',
	'openai-codex',
	'opencode',
	'opencode-go',
	'openrouter',
	'together',
	'vercel-ai-gateway',
	'xai',
	'xiaomi',
	'xiaomi-token-plan-ams',
	'xiaomi-token-plan-cn',
	'xiaomi-token-plan-sgp',
	'zai',
] as const;

export type BuiltInProvider = (typeof BUILT_IN_PROVIDERS)[number];

const ANTHROPIC_PROVIDERS = [
	'anthropic',
	'cloudflare-ai-gateway',
	'fireworks',
	'github-copilot',
	'kimi-coding',
	'minimax',
	'minimax-cn',
	'opencode',
	'opencode-go',
	'vercel-ai-gateway',
] as const satisfies readonly BuiltInProvider[];
const OPENAI_COMPLETIONS_PROVIDERS = [
	'cerebras',
	'cloudflare-ai-gateway',
	'cloudflare-workers-ai',
	'deepseek',
	'github-copilot',
	'groq',
	'huggingface',
	'moonshotai',
	'moonshotai-cn',
	'openai',
	'opencode',
	'opencode-go',
	'openrouter',
	'together',
	'xai',
	'xiaomi',
	'xiaomi-token-plan-ams',
	'xiaomi-token-plan-cn',
	'xiaomi-token-plan-sgp',
	'zai',
] as const satisfies readonly BuiltInProvider[];
const OPENAI_RESPONSES_PROVIDERS = [
	'cloudflare-ai-gateway',
	'github-copilot',
	'openai',
	'opencode',
] as const satisfies readonly BuiltInProvider[];

const UNAVAILABLE_PROVIDER_PREFIX = '\0virtual:flue/unavailable-pi-ai-provider:';
const CHAT_BUILTINS_SUFFIX = '/@earendil-works/pi-ai/dist/providers/register-builtins.js';
const IMAGE_BUILTINS_SUFFIX = '/@earendil-works/pi-ai/dist/providers/images/register-builtins.js';
const BEDROCK_IMPORT = 'importNodeOnlyProvider("./amazon-bedrock.ts")';

const PROVIDER_IMPORTS: Record<
	string,
	{ providers: readonly BuiltInProvider[]; exports: readonly string[] }
> = {
	'./anthropic.js': {
		providers: ANTHROPIC_PROVIDERS,
		exports: ['streamAnthropic', 'streamSimpleAnthropic'],
	},
	'./azure-openai-responses.js': {
		providers: ['azure-openai-responses'],
		exports: ['streamAzureOpenAIResponses', 'streamSimpleAzureOpenAIResponses'],
	},
	'./google.js': {
		providers: ['google', 'opencode'],
		exports: ['streamGoogle', 'streamSimpleGoogle'],
	},
	'./google-vertex.js': {
		providers: ['google-vertex'],
		exports: ['streamGoogleVertex', 'streamSimpleGoogleVertex'],
	},
	'./mistral.js': {
		providers: ['mistral'],
		exports: ['streamMistral', 'streamSimpleMistral'],
	},
	'./openai-codex-responses.js': {
		providers: ['openai-codex'],
		exports: ['streamOpenAICodexResponses', 'streamSimpleOpenAICodexResponses'],
	},
	'./openai-completions.js': {
		providers: OPENAI_COMPLETIONS_PROVIDERS,
		exports: ['streamOpenAICompletions', 'streamSimpleOpenAICompletions'],
	},
	'./openai-responses.js': {
		providers: OPENAI_RESPONSES_PROVIDERS,
		exports: ['streamOpenAIResponses', 'streamSimpleOpenAIResponses'],
	},
};

const IMAGE_PROVIDER_IMPORTS: Record<
	string,
	{ providers: readonly BuiltInProvider[]; exports: readonly string[] }
> = {
	'./openrouter.js': {
		providers: ['openrouter'],
		exports: ['generateImagesOpenRouter'],
	},
};

export function piAiProviderAllowlistPlugin(providers: readonly BuiltInProvider[] = []): Plugin {
	const enabled = new Set(providers);
	return {
		name: 'flue-pi-ai-provider-allowlist',
		enforce: 'pre',
		resolveId(source, importer) {
			const imports = importer?.endsWith(CHAT_BUILTINS_SUFFIX)
				? PROVIDER_IMPORTS
				: importer?.endsWith(IMAGE_BUILTINS_SUFFIX)
					? IMAGE_PROVIDER_IMPORTS
					: undefined;
			const definition = imports?.[source];
			if (!definition || definition.providers.some((provider) => enabled.has(provider))) return null;
			return `${UNAVAILABLE_PROVIDER_PREFIX}${source}`;
		},
		load(id) {
			if (!id.startsWith(UNAVAILABLE_PROVIDER_PREFIX)) return null;
			const source = id.slice(UNAVAILABLE_PROVIDER_PREFIX.length);
			const definition = PROVIDER_IMPORTS[source] ?? IMAGE_PROVIDER_IMPORTS[source];
			if (!definition) throw new Error(`[flue] Unknown excluded pi-ai provider module: ${source}`);
			return unavailableProviderModule(recommendedProviderFor(source), definition.exports);
		},
		transform(code, id) {
			if (!id.endsWith(CHAT_BUILTINS_SUFFIX)) return null;
			if (!code.includes(BEDROCK_IMPORT)) {
				throw new Error('[flue] The audited pi-ai built-in provider layout changed. Update Flue before building.');
			}
			return {
				code: code.replace(
					BEDROCK_IMPORT,
					`Promise.reject(new Error(${JSON.stringify(unavailableProviderMessage('amazon-bedrock', 'amazon-bedrock'))}))`,
				),
				map: null,
			};
		},
	};
}

function unavailableProviderModule(recommendedProvider: BuiltInProvider, exports: readonly string[]): string {
	return `const unavailable = (model) => { throw new Error(\`[flue] Provider "\${model?.provider ?? ${JSON.stringify(recommendedProvider)}}" is not included in this build. Add ${JSON.stringify(recommendedProvider)} to providers in flue.config.ts.\`); };\n${exports.map((name) => `export const ${name} = unavailable;`).join('\n')}\n`;
}

function recommendedProviderFor(source: string): BuiltInProvider {
	if (source === './openai-completions.js' || source === './openai-responses.js') return 'openai';
	return (PROVIDER_IMPORTS[source] ?? IMAGE_PROVIDER_IMPORTS[source])?.providers[0] ?? 'openai';
}

function unavailableProviderMessage(provider: string, recommendedProvider: BuiltInProvider): string {
	return `[flue] Provider "${provider}" is not included in this build. Add "${recommendedProvider}" to providers in flue.config.ts.`;
}
