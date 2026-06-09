import { describe, it } from 'vite-plus/test';

describe('registerProvider()', () => {
	it.todo(
		'routes a model operation through a registered HTTP provider when the model uses its provider id',
	);
	it.todo(
		'routes later model operations through the latest registration when a provider id is registered repeatedly',
	);
	it.todo(
		'applies registered headers and default model metadata when an operation uses a registered provider',
	);
	it.todo(
		'applies model-specific metadata overrides when an operation uses the configured model id',
	);
	it.todo('rejects a model operation when a registered provider specifier omits its model id');
});

describe('configureProvider()', () => {
	it.todo(
		'sends built-in-provider operations to the configured base URL when configuration supplies a base URL',
	);
	it.todo(
		'sends merged catalog and configured headers when a configured provider already has headers',
	);
	it.todo('uses configured API keys when an operation calls a configured provider');
	it.todo('prefers a configured API key when a registered provider also supplies an API key');
	it.todo(
		'uses the latest transport configuration for later operations when a provider id is configured repeatedly',
	);
	it.todo(
		'sends store true only when storeResponses is enabled for an OpenAI Responses API provider',
	);
});
