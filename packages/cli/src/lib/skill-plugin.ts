import * as esbuild from 'esbuild';
import * as path from 'node:path';
import { buildSkillDefinition } from './skill-frontmatter.ts';

export function skillBundlerPlugin(): esbuild.Plugin {
	return {
		name: 'flue-skill-bundler',
		setup(build) {
			build.onResolve({ filter: /.*/ }, (args) => {
				if (args.with?.type !== 'skill') return null;
				return {
					path: path.resolve(path.dirname(args.importer), args.path),
					namespace: 'flue-skill',
				};
			});

			build.onResolve({ filter: /.*/ }, (args) => {
				if (args.kind === 'entry-point') return null;
				const isRelative = args.path.startsWith('.') || args.path.startsWith('/');
				if (!isRelative || args.path.includes('node_modules')) {
					return { path: args.path, external: true };
				}
				if (/\.(md|markdown)$/i.test(args.path)) {
					throw new Error(
						`[flue] Markdown import "${args.path}" must use an import attribute: ` +
							`with { type: 'skill' }.`,
					);
				}
				return null;
			});

			build.onLoad({ filter: /.*/, namespace: 'flue-skill' }, async (args) => {
				if (!/\/SKILL\.md$/i.test(args.path.replace(/\\/g, '/'))) {
					throw new Error(`[flue] Skill imports must target a SKILL.md file: ${args.path}`);
				}
				const { skill, watchFiles } = await buildSkillDefinition(args.path);
				return {
					contents: `const skill = ${JSON.stringify(skill)}; export default skill;`,
					loader: 'ts',
					watchFiles,
				};
			});
		},
	};
}
