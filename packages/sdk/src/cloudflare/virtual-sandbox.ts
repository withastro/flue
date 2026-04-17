/**
 * In-process just-bash sandbox for Cloudflare Workers (no container).
 * Without args: empty in-memory. With R2 bucket: persistent files via DO SQLite + R2.
 */
import {
	Workspace,
	WorkspaceFileSystem,
	type FileSystem as CfFileSystem,
	type FsStat as CfFsStat,
} from '@cloudflare/shell';
import { getCloudflareContext } from './context.ts';

export interface VirtualSandboxOptions {
	/** R2 key prefix for session isolation. */
	prefix?: string;
}

function adaptStat(cfStat: CfFsStat) {
	return {
		isFile: cfStat.type === 'file',
		isDirectory: cfStat.type === 'directory',
		isSymbolicLink: cfStat.type === 'symlink',
		mode: cfStat.mode ?? (cfStat.type === 'directory' ? 0o755 : 0o644),
		size: cfStat.size,
		mtime: cfStat.mtime,
	};
}

function adaptToJustBash(cfFs: CfFileSystem): any {
	return {
		readFile: (path: string, _opts?: any) => cfFs.readFile(path),
		readFileBuffer: (path: string) => cfFs.readFileBytes(path),

		async writeFile(path: string, content: string | Uint8Array, _opts?: any) {
			if (typeof content === 'string') {
				await cfFs.writeFile(path, content);
			} else {
				await cfFs.writeFileBytes(path, content);
			}
		},

		appendFile: (path: string, content: string, _opts?: any) => cfFs.appendFile(path, content),
		exists: (path: string) => cfFs.exists(path),

		async stat(path: string) {
			return adaptStat(await cfFs.stat(path));
		},

		async lstat(path: string) {
			return adaptStat(await cfFs.lstat(path));
		},

		mkdir: (path: string, opts?: any) => cfFs.mkdir(path, opts),
		readdir: (path: string) => cfFs.readdir(path),

		async readdirWithFileTypes(path: string) {
			const entries = await cfFs.readdirWithFileTypes(path);
			return entries.map((e: any) => ({
				name: e.name,
				isFile: e.type === 'file',
				isDirectory: e.type === 'directory',
				isSymbolicLink: e.type === 'symlink',
			}));
		},

		rm: (path: string, opts?: any) => cfFs.rm(path, opts),
		cp: (src: string, dest: string, opts?: any) => cfFs.cp(src, dest, opts),
		mv: (src: string, dest: string) => cfFs.mv(src, dest),
		resolvePath: (base: string, path: string) => cfFs.resolvePath(base, path),
		getAllPaths: () => [],
		async chmod(_path: string, _mode: number) {},
		symlink: (target: string, linkPath: string) => cfFs.symlink(target, linkPath),

		async link(existingPath: string, newPath: string) {
			const content = await cfFs.readFileBytes(existingPath);
			await cfFs.writeFileBytes(newPath, content);
		},

		readlink: (path: string) => cfFs.readlink(path),
		realpath: (path: string) => cfFs.realpath(path),
		async utimes(_path: string, _atime: number, _mtime: number) {},
	};
}

export async function getVirtualSandbox(): Promise<any>;
export async function getVirtualSandbox(
	bucket: unknown,
	options?: VirtualSandboxOptions,
): Promise<any>;
export async function getVirtualSandbox(
	bucket?: unknown,
	options?: VirtualSandboxOptions,
): Promise<any> {
	if (bucket === undefined) {
		const { Bash, InMemoryFs } = await import(/* @vite-ignore */ 'just-bash' as string);
		return new Bash({
			fs: new InMemoryFs(),
			network: { dangerouslyAllowFullInternetAccess: true },
		});
	}

	const { storage } = getCloudflareContext();
	const prefix = options?.prefix ?? 'default';

	const ws = new Workspace({
		sql: storage.sql,
		r2: bucket as any,
		name: () => prefix,
	});

	const cfFs: CfFileSystem = new WorkspaceFileSystem(ws);
	const r2Adapter = adaptToJustBash(cfFs);

	const { Bash, MountableFs, InMemoryFs } = await import(/* @vite-ignore */ 'just-bash' as string);

	const fs = new MountableFs({ base: new InMemoryFs() });
	fs.mount('/workspace', r2Adapter);

	return new Bash({
		fs,
		cwd: '/workspace',
		network: { dangerouslyAllowFullInternetAccess: true },
	});
}
