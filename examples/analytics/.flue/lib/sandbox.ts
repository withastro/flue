import type { LocalSandboxOptions } from '@flue/runtime/node';
import { local } from '@flue/runtime/node';
import type { SandboxFactory } from '@flue/runtime';

export function localWithoutBuiltinTools(
	options: LocalSandboxOptions & { disableTaskTool?: boolean } = {},
): SandboxFactory {
	const base = local(options);
	const sandbox = {
		createSessionEnv: base.createSessionEnv,
		tools: () => [],
		disableTaskTool: options.disableTaskTool,
	};
	return sandbox as SandboxFactory;
}
