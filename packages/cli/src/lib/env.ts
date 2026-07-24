import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseEnv } from 'node:util';
import { UsageError } from '../errors.ts';

export interface EnvLoader {
	readonly file: string;
	apply(): void;
	restore(): void;
}

export function selectEnvFile(envFile: string | undefined, baseDir: string): string {
	if (!envFile) return path.join(baseDir, '.env');
	const absolute = path.isAbsolute(envFile) ? envFile : path.resolve(baseDir, envFile);
	if (!fs.existsSync(absolute)) {
		throw new UsageError(`--env points at a path that doesn't exist: ${envFile}`);
	}
	return absolute;
}

function parseEnvFile(file: string): Record<string, string> {
	if (!fs.existsSync(file)) return {};
	return parseEnv(fs.readFileSync(file, 'utf-8')) as Record<string, string>;
}

export function createEnvLoader(
	file: string,
	initialEnvironment: NodeJS.ProcessEnv = process.env,
): EnvLoader {
	const original = { ...initialEnvironment };
	const managed = new Set<string>();
	const restore = () => {
		for (const key of managed) {
			const existing = original[key];
			if (existing === undefined) delete process.env[key];
			else process.env[key] = existing;
		}
	};
	const apply = () => {
		const selected = parseEnvFile(file);
		for (const key of Object.keys(selected)) managed.add(key);
		restore();
		for (const [key, value] of Object.entries(selected)) {
			// A variable already present in the process environment wins over the
			// same key in the .env file — the file only fills gaps.
			if (original[key] === undefined) process.env[key] = value;
		}
	};
	return {
		file,
		apply,
		restore,
	};
}
