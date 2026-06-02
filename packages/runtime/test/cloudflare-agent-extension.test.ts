import { describe, expect, it } from 'vitest';
import {
	extend,
	type CloudflareAgentClass,
	resolveCloudflareAgentExtension,
} from '../src/cloudflare/agent-extension.ts';

class Agent {}

describe('resolveCloudflareAgentExtension()', () => {
	it('defaults omitted extension callbacks to identity operations', () => {
		const extension = resolveCloudflareAgentExtension({ cloudflare: extend({}) }, 'assistant');

		expect(extension.base(Agent)).toBe(Agent);
		expect(extension.wrap(Agent)).toBe(Agent);
	});

	it('accepts constructor proxies returned by wrap callbacks', () => {
		const extension = resolveCloudflareAgentExtension(
			{ cloudflare: extend({ wrap: (Final) => new Proxy(Final, {}) }) },
			'assistant',
		);

		expect(extension.wrap(Agent)).not.toBe(Agent);
	});

	it('rejects malformed agent cloudflare exports', () => {
		expect(() => resolveCloudflareAgentExtension({ cloudflare: {} }, 'assistant')).toThrow(
			'cloudflare export must be created with extend({ base, wrap })',
		);
	});

	it('rejects malformed base callbacks', () => {
		expect(() =>
			resolveCloudflareAgentExtension({ cloudflare: extend({ base: true as never }) }, 'assistant'),
		).toThrow('cloudflare.base must be a function');
	});

	it('rejects malformed wrap callbacks', () => {
		expect(() =>
			resolveCloudflareAgentExtension({ cloudflare: extend({ wrap: true as never }) }, 'assistant'),
		).toThrow('cloudflare.wrap must be a function');
	});

	it('rejects base callbacks that return unrelated classes', () => {
		const extension = resolveCloudflareAgentExtension(
			{ cloudflare: extend({ base: () => class {} }) },
			'assistant',
		);

		expect(() => extension.base(Agent)).toThrow(
			'cloudflare.base(Agent) must return the received class or a subclass',
		);
	});

	it('rejects wrap callbacks that return unrelated classes', () => {
		const extension = resolveCloudflareAgentExtension(
			{ cloudflare: extend({ wrap: () => class {} }) },
			'assistant',
		);

		expect(() => extension.wrap(Agent)).toThrow(
			'cloudflare.wrap(Final) must return the received class or a constructor proxy',
		);
	});

	it('rejects wrap callbacks that return subclasses', () => {
		const extension = resolveCloudflareAgentExtension(
			{ cloudflare: extend({ wrap: (Final) => class extends Final {} }) },
			'assistant',
		);

		expect(() => extension.wrap(Agent)).toThrow(
			'cloudflare.wrap(Final) must return the received class or a constructor proxy',
		);
	});

	it('rejects non-constructable prototype-preserving wrappers', () => {
		const extension = resolveCloudflareAgentExtension(
			{
				cloudflare: extend({
					wrap: (Final) => {
						const wrapper = () => Final;
						wrapper.prototype = Final.prototype;
						return wrapper as never;
					},
				}),
			},
			'assistant',
		);

		expect(() => extension.wrap(Agent)).toThrow(
			'cloudflare.wrap(Final) must return the received class or a constructor proxy',
		);
	});

	it('rejects malformed extend descriptors', () => {
		expect(() => extend(null as never)).toThrow('extend() expects an object');
		expect(() => extend(undefined as never)).toThrow('extend() expects an object');
		expect(() => extend([] as never)).toThrow('extend() expects an object');
	});

	it('rejects unknown extend descriptor options', () => {
		expect(() => extend({ warp: (Final: CloudflareAgentClass) => Final } as never)).toThrow(
			'extend() received unknown option(s): warp',
		);
	});

	it('rejects legacy CloudflareAgent exports with migration guidance', () => {
		expect(() => resolveCloudflareAgentExtension({ CloudflareAgent: Agent }, 'assistant')).toThrow(
			'CloudflareAgent export is no longer supported. Export cloudflare = extend({ base, wrap }) instead.',
		);
	});
});
