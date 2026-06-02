const CLOUDFLARE_AGENT_EXTENSION = Symbol.for('@flue/runtime/cloudflare-agent-extension');

export type CloudflareAgentClass = new (...args: any[]) => any;

export interface CloudflareAgentExtension {
	base?: (Base: CloudflareAgentClass) => CloudflareAgentClass;
	wrap?: (Final: CloudflareAgentClass) => CloudflareAgentClass;
}

interface BrandedCloudflareAgentExtension extends CloudflareAgentExtension {
	[CLOUDFLARE_AGENT_EXTENSION]: true;
}

export interface ResolvedCloudflareAgentExtension {
	base(Base: CloudflareAgentClass): CloudflareAgentClass;
	wrap(Final: CloudflareAgentClass): CloudflareAgentClass;
}

export function extend(extension: CloudflareAgentExtension): CloudflareAgentExtension {
	if (typeof extension !== 'object' || extension === null || Array.isArray(extension)) {
		throw new Error('[flue] extend() expects an object containing optional base and wrap callbacks.');
	}
	const unknownKeys = Object.keys(extension).filter((key) => key !== 'base' && key !== 'wrap');
	if (unknownKeys.length > 0) {
		throw new Error(`[flue] extend() received unknown option(s): ${unknownKeys.join(', ')}.`);
	}
	const branded: BrandedCloudflareAgentExtension = {
		...extension,
		[CLOUDFLARE_AGENT_EXTENSION]: true,
	};
	return branded;
}

export function resolveCloudflareAgentExtension(
	mod: Record<string, unknown>,
	name: string,
): ResolvedCloudflareAgentExtension {
	if (mod.CloudflareAgent !== undefined) {
		throw new Error(
			`[flue] Agent "${name}" CloudflareAgent export is no longer supported. Export cloudflare = extend({ base, wrap }) instead.`,
		);
	}
	const extension = mod.cloudflare;
	if (extension === undefined) return { base: identity, wrap: identity };
	if (!isCloudflareAgentExtension(extension)) {
		throw new Error(
			`[flue] Agent "${name}" cloudflare export must be created with extend({ base, wrap }) from "@flue/runtime/cloudflare".`,
		);
	}
	const base = extension.base === undefined ? identity : extension.base;
	const wrap = extension.wrap === undefined ? identity : extension.wrap;
	if (typeof base !== 'function') {
		throw new Error(`[flue] Agent "${name}" cloudflare.base must be a function.`);
	}
	if (typeof wrap !== 'function') {
		throw new Error(`[flue] Agent "${name}" cloudflare.wrap must be a function.`);
	}
	return {
		base(Base) {
			return assertCloudflareAgentClass(base(Base), Base, name, 'base(Agent)');
		},
		wrap(Final) {
			return assertCloudflareAgentWrapper(wrap(Final), Final, name);
		},
	};
}

function identity<T>(value: T): T {
	return value;
}

function isCloudflareAgentExtension(value: unknown): value is CloudflareAgentExtension {
	return (
		typeof value === 'object' &&
		value !== null &&
		CLOUDFLARE_AGENT_EXTENSION in value &&
		(value as BrandedCloudflareAgentExtension)[CLOUDFLARE_AGENT_EXTENSION] === true
	);
}

function assertCloudflareAgentClass(
	value: unknown,
	Base: CloudflareAgentClass,
	name: string,
	source: string,
): CloudflareAgentClass {
	if (
		typeof value !== 'function' ||
		(value !== Base && !(value.prototype instanceof Base)) ||
		!isConstructable(value as CloudflareAgentClass)
	) {
		throw new Error(
			`[flue] Agent "${name}" cloudflare.${source} must return the received class or a subclass.`,
		);
	}
	return value as CloudflareAgentClass;
}

function assertCloudflareAgentWrapper(
	value: unknown,
	Final: CloudflareAgentClass,
	name: string,
): CloudflareAgentClass {
	if (
		typeof value !== 'function' ||
		(value !== Final && value.prototype !== Final.prototype) ||
		!isConstructable(value as CloudflareAgentClass)
	) {
		throw new Error(
			`[flue] Agent "${name}" cloudflare.wrap(Final) must return the received class or a constructor proxy.`,
		);
	}
	return value as CloudflareAgentClass;
}

function isConstructable(value: CloudflareAgentClass): boolean {
	try {
		Reflect.construct(Function, [], value);
		return true;
	} catch {
		return false;
	}
}
