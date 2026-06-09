import { defineConfig } from 'vite-plus';

const rootBuildEntry = 'flue:root-build-entry';
const rootBuildResolvedEntry = `\0${rootBuildEntry}`;

export default defineConfig({
	plugins: [
		{
			name: 'flue-root-build-entry',
			resolveId(id) {
				if (id === rootBuildEntry) return rootBuildResolvedEntry;
			},
			load(id) {
				if (id === rootBuildResolvedEntry) return 'export {};';
			},
		},
	],
	build: {
		outDir: '.flue-vite/root-build',
		rollupOptions: {
			input: rootBuildEntry,
			output: {
				entryFileNames: 'noop.mjs',
			},
		},
	},
	run: {
		tasks: {
			build: "vp run --filter './packages/*' --filter './apps/*' build",
			check: ['vp run build', 'vp run check:lint', 'vp run check:types', 'vp run test'],
			'check:knip': 'vp exec knip',
			'check:lint': ['vp check --no-fmt', 'vp exec knip'],
			'check:types': "vp run --filter './packages/*' --filter './apps/docs' check:types",
			dev: {
				command: 'vp run --filter ./apps/* --parallel dev',
				cache: false,
			},
			format: 'vp check --fix',
			'format:lint': 'vp check --fix --no-fmt',
			'format:style': 'vp fmt . --check',
			test: {
				command: [
					'cd packages/runtime && vp run test',
					'cd packages/sdk && vp run test',
					'cd packages/opentelemetry && vp run test',
					'cd packages/postgres && vp run test',
					'cd packages/cli && vp run test',
				],
			},
			'test:integration': {
				command: 'vp run @flue/runtime#test:integration:cloudflare',
				dependsOn: ['@flue/runtime#build'],
				cache: false,
			},
		},
	},
	test: {
		include: [],
		passWithNoTests: true,
	},
	staged: {
		'*': 'vp check --fix',
	},
	lint: {
		ignorePatterns: [
			'apps/www/**',
			'apps/docs/**/*.astro',
			'.agents/**',
			'**/.astro/**',
			'**/.flue-vite/**',
			'**/.wrangler/**',
			'**/dist/**',
			'**/node_modules/**',
			'**/.cache/**',
			'packages/cli/bin/_connectors.generated.ts',
			'connectors/sandbox*.md',
			'plans/**',
		],
		plugins: ['typescript', 'unicorn', 'node', 'import'],
		jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
		options: {
			typeAware: false,
			typeCheck: false,
		},
		rules: {
			'vite-plus/prefer-vite-plus-imports': 'error',
			'import/extensions': 'off',
			'no-console': 'off',
			'no-debugger': 'warn',
			'no-unused-vars': 'warn',
			'typescript/no-explicit-any': 'off',
			'typescript/no-inferrable-types': 'off',
			'typescript/no-non-null-assertion': 'warn',
			'typescript/triple-slash-reference': 'off',
			'typescript/no-unnecessary-template-expression': 'off',
			'unicorn/no-array-for-each': 'off',
			'unicorn/no-thenable': 'off',
			'unicorn/prefer-node-protocol': 'warn',
		},
		overrides: [
			{
				files: ['packages/sdk/src/**', 'examples/**'],
				rules: {
					'no-console': 'off',
				},
			},
			{
				files: ['packages/cli/src/**', 'packages/cli/bin/**'],
				rules: {
					'vite-plus/prefer-vite-plus-imports': 'off',
				},
			},
		],
	},
	fmt: {
		printWidth: 100,
		semi: true,
		singleQuote: true,
		tabWidth: 2,
		trailingComma: 'all',
		useTabs: true,
		sortPackageJson: false,
		ignorePatterns: [
			'**/.astro/**',
			'**/.flue-vite/**',
			'**/.wrangler/**',
			'.agents/**',
			'**/dist/**',
			'**/node_modules/**',
			'**/.cache/**',
			'**/pnpm-lock.yaml',
			'packages/cli/bin/_connectors.generated.ts',
			'connectors/sandbox*.md',
			'plans/**',
		],
		overrides: [
			{
				files: ['.*', '*.md', '*.toml', '*.yml'],
				options: {
					useTabs: false,
				},
			},
			{
				files: ['**/*.jsonc'],
				options: {
					trailingComma: 'none',
				},
			},
		],
	},
});
