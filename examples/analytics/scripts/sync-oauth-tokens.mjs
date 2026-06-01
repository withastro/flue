import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot =
	process.env.DBT_EXPLORER_API_ROOT ||
	path.resolve(SCRIPT_DIR, '../../../..', 'evenup-internal-tools/apps/dbt-explorer-api');
const targetEnvPath =
	process.env.TARGET_ENV_PATH || path.join(process.cwd(), '.env.secrets');

async function main() {
	const sourceEnv = await loadMergedEnv(sourceRoot);
	const userEmail =
		process.env.USER_EMAIL || sourceEnv.DEV_IDENTITY_EMAIL || sourceEnv.DEV_IDENTITY_EMAIL?.replace(/['"]/g, '');
	if (!userEmail) {
		throw new Error('Could not determine user email. Set USER_EMAIL or DEV_IDENTITY_EMAIL.');
	}

	const pythonPath = path.join(sourceRoot, '.venv', 'bin', 'python');
	const payload = await readTokensFromSource({
		sourceRoot,
		pythonPath,
		userEmail,
		env: {
			...process.env,
			...sourceEnv,
		},
	});

	await updateEnvFile(targetEnvPath, payload);

	const available = Object.entries(payload)
		.filter(([, value]) => typeof value === 'string' && value)
		.map(([key]) => key);
	console.log(
		JSON.stringify(
			{
				ok: true,
				userEmail,
				targetEnvPath,
				available,
			},
			null,
			2,
		),
	);
}

async function loadMergedEnv(root) {
	const merged = {};
	for (const filename of ['.env', '.env.secrets']) {
		const filePath = path.join(root, filename);
		try {
			const raw = await fs.readFile(filePath, 'utf8');
			Object.assign(merged, parseEnv(raw));
		} catch (error) {
			if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
			throw error;
		}
	}
	return merged;
}

function parseEnv(raw) {
	const values = {};
	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
		if (!match) continue;
		let value = match[2] ?? '';
		if (
			(value.startsWith("'") && value.endsWith("'")) ||
			(value.startsWith('"') && value.endsWith('"'))
		) {
			value = value.slice(1, -1);
		}
		values[match[1]] = value;
	}
	return values;
}

async function readTokensFromSource({ sourceRoot, pythonPath, userEmail, env }) {
	const program = [
		'import asyncio, json, os, sys',
		"sys.path.insert(0, os.getcwd())",
		'import event_store',
		'import personal_store',
		'from oauth import refresh_google_token',
		`USER_EMAIL = ${JSON.stringify(userEmail)}`,
		'async def main():',
		'    event_store.init_firestore()',
		'    slack = await personal_store.get_slack_token(USER_EMAIL)',
		'    google_doc = await personal_store.get_google_token(USER_EMAIL)',
		'    try:',
		'        google = await refresh_google_token(USER_EMAIL)',
		'    except Exception:',
		'        google = (google_doc or {}).get("accessToken", "")',
		'    payload = {',
		'        "SLACK_USER_TOKEN": (slack or {}).get("accessToken", ""),',
		'        "GOOGLE_USER_ACCESS_TOKEN": google or "",',
		'    }',
		'    print(json.dumps(payload))',
		'asyncio.run(main())',
	].join('\n');

	const { stdout, stderr } = await execFileAsync(pythonPath, ['-c', program], {
		cwd: sourceRoot,
		env,
	});
	if (stderr.trim()) {
		// Firestore and google libs can be chatty; only surface if stdout is empty.
		if (!stdout.trim()) throw new Error(stderr.trim());
	}
	const payload = JSON.parse(stdout.trim());
	return {
		SLACK_USER_TOKEN: payload.SLACK_USER_TOKEN || '',
		GOOGLE_USER_ACCESS_TOKEN: payload.GOOGLE_USER_ACCESS_TOKEN || '',
	};
}

async function updateEnvFile(filePath, updates) {
	let raw = '';
	try {
		raw = await fs.readFile(filePath, 'utf8');
	} catch (error) {
		if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
			throw error;
		}
	}

	let next = raw;
	for (const [key, value] of Object.entries(updates)) {
		const line = `${key}=${quoteEnv(value)}`;
		const pattern = new RegExp(`^${key}=.*$`, 'm');
		if (pattern.test(next)) {
			next = next.replace(pattern, line);
		} else {
			next = `${next}${next.endsWith('\n') || next === '' ? '' : '\n'}${line}\n`;
		}
	}

	await fs.writeFile(filePath, next, 'utf8');
}

function quoteEnv(value) {
	return JSON.stringify(value ?? '');
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
