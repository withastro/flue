import * as esbuild from 'esbuild';
import { skillBundlerPlugin } from './skill-plugin.ts';

export async function bundleSkillImports(entryPath: string, outfile: string): Promise<void> {
	await esbuild.build({
		entryPoints: [entryPath],
		outfile,
		bundle: true,
		format: 'esm',
		platform: 'neutral',
		write: true,
		sourcemap: true,
		logLevel: 'warning',
		plugins: [skillBundlerPlugin()],
	});
}
