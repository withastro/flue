throw new Error(
	'[@flue/runtime] The @flue/runtime/sandbox entrypoint has been folded into the root @flue/runtime export. ' +
		'Update imports from "@flue/runtime/sandbox" to "@flue/runtime". ' +
		'See the changelog: https://github.com/withastro/flue/blob/main/CHANGELOG.md#unreleased',
);

// Preserve the old type surface for one release so TypeScript users get the
// runtime migration error instead of a less helpful "module has no export".
export type { SandboxFactory, SessionEnv, FileStat } from './types.ts';
export { createSandboxSessionEnv, type SandboxApi } from './sandbox.ts';
