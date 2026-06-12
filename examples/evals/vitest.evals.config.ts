import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['evals/**/*.eval.ts'],
		testTimeout: 60_000,
		hookTimeout: 60_000,
		reporters: ['vitest-evals/reporter'],
		env: {
			FLUE_EVAL_BASE_URL: process.env.FLUE_EVAL_BASE_URL ?? 'http://localhost:3583',
			FLUE_EVAL_WITH_JUDGES: process.env.FLUE_EVAL_WITH_JUDGES ?? '0',
		},
	},
});
