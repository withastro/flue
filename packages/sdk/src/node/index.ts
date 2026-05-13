import { throwMigrationError } from '../_migration.ts';

throwMigrationError();

export interface LocalSessionEnvOptions {
	cwd?: string;
}

export const createLocalSessionEnv = throwMigrationError;
