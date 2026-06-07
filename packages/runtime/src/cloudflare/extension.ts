const CLOUDFLARE_EXTENSION = Symbol.for('@flue/runtime/cloudflare-extension');

export type ExtensionClass = new (...args: any[]) => any;

export interface CloudflareExtension {
	base?: (Base: ExtensionClass) => ExtensionClass;
	wrap?: (Final: ExtensionClass) => ExtensionClass;
}

interface BrandedCloudflareExtension extends CloudflareExtension {
	[CLOUDFLARE_EXTENSION]: true;
}

export interface ResolvedCloudflareExtension {
	base(Base: ExtensionClass): ExtensionClass;
	wrap(Final: ExtensionClass): ExtensionClass;
}

export function extend(extension: CloudflareExtension): CloudflareExtension {
	if (typeof extension !== 'object' || extension === null || Array.isArray(extension)) {
		throw new Error(
			'[flue] extend() expects an object containing optional base and wrap callbacks.',
		);
	}
	const unknownKeys = Object.keys(extension).filter((key) => key !== 'base' && key !== 'wrap');
	if (unknownKeys.length > 0) {
		throw new Error(`[flue] extend() received unknown option(s): ${unknownKeys.join(', ')}.`);
	}
	const branded: BrandedCloudflareExtension = {
		...extension,
		[CLOUDFLARE_EXTENSION]: true,
	};
	return branded;
}

export function resolveCloudflareExtension(
	mod: Record<string, unknown>,
	name: string,
	kind: 'Agent' | 'Workflow',
): ResolvedCloudflareExtension {
	const extension = mod.cloudflare;
	if (extension === undefined) return { base: identity, wrap: identity };
	if (!isCloudflareExtension(extension)) {
		throw new Error(
			`[flue] ${kind} "${name}" cloudflare export must be created with extend({ base, wrap }) from "@flue/runtime/cloudflare".`,
		);
	}
	const base = extension.base === undefined ? identity : extension.base;
	const wrap = extension.wrap === undefined ? identity : extension.wrap;
	if (typeof base !== 'function') {
		throw new Error(`[flue] ${kind} "${name}" cloudflare.base must be a function.`);
	}
	if (typeof wrap !== 'function') {
		throw new Error(`[flue] ${kind} "${name}" cloudflare.wrap must be a function.`);
	}
	return {
		base(Base) {
			return assertExtensionClass(base(Base), Base, name, kind);
		},
		wrap(Final) {
			return assertExtensionWrapper(wrap(Final), Final, name, kind);
		},
	};
}

function identity<T>(value: T): T {
	return value;
}

function isCloudflareExtension(value: unknown): value is CloudflareExtension {
	return (
		typeof value === 'object' &&
		value !== null &&
		CLOUDFLARE_EXTENSION in value &&
		(value as BrandedCloudflareExtension)[CLOUDFLARE_EXTENSION] === true
	);
}

function assertExtensionClass(
	value: unknown,
	Base: ExtensionClass,
	name: string,
	kind: string,
): ExtensionClass {
	if (
		typeof value !== 'function' ||
		(value !== Base && !(value.prototype instanceof Base)) ||
		!isConstructable(value as ExtensionClass)
	) {
		throw new Error(
			`[flue] ${kind} "${name}" cloudflare.base must return the received class or a subclass.`,
		);
	}
	return value as ExtensionClass;
}

function assertExtensionWrapper(
	value: unknown,
	Final: ExtensionClass,
	name: string,
	kind: string,
): ExtensionClass {
	if (
		typeof value !== 'function' ||
		(value !== Final && value.prototype !== Final.prototype) ||
		!isConstructable(value as ExtensionClass)
	) {
		throw new Error(
			`[flue] ${kind} "${name}" cloudflare.wrap(Final) must return the received class or a constructor proxy.`,
		);
	}
	return value as ExtensionClass;
}

function isConstructable(value: ExtensionClass): boolean {
	try {
		Reflect.construct(Function, [], value);
		return true;
	} catch {
		return false;
	}
}
