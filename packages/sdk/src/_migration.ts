export const MIGRATION_MESSAGE =
	'[@flue/sdk] This package has moved. Runtime APIs are now exported from "@flue/runtime", ' +
	'and build/dev/config APIs are now exported from "@flue/cli". ' +
	'Update your imports and see the changelog: ' +
	'https://github.com/withastro/flue/blob/main/CHANGELOG.md#unreleased';

export function throwMigrationError(): never {
	throw new Error(MIGRATION_MESSAGE);
}

export type Json = unknown;
