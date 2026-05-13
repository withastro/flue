import { defineConfig } from '@hey-api/openapi-ts';

export default defineConfig([
	{
		input: { path: './specs/public.openapi.json' },
		output: 'src/generated/public',
		plugins: ['@hey-api/typescript'],
	},
	{
		input: { path: './specs/admin.openapi.json' },
		output: 'src/generated/admin',
		plugins: ['@hey-api/typescript'],
	},
]);
