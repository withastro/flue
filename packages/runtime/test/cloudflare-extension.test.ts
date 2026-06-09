import { describe, expect, it } from 'vite-plus/test';
import {
	extend,
	type ExtensionClass,
	resolveCloudflareExtension,
} from '../src/cloudflare/extension.ts';

class Agent {}

describe('resolveCloudflareExtension()', () => {
	it('defaults omitted extension callbacks to identity operations for agents', () => {
		const extension = resolveCloudflareExtension({ cloudflare: extend({}) }, 'assistant', 'Agent');

		expect(extension.base(Agent)).toBe(Agent);
		expect(extension.wrap(Agent)).toBe(Agent);
	});

	it('returns identity when no cloudflare export is present for agents', () => {
		const extension = resolveCloudflareExtension({}, 'assistant', 'Agent');

		expect(extension.base(Agent)).toBe(Agent);
		expect(extension.wrap(Agent)).toBe(Agent);
	});

	it('accepts constructor proxies returned by wrap callbacks for agents', () => {
		const extension = resolveCloudflareExtension(
			{ cloudflare: extend({ wrap: (Final) => new Proxy(Final, {}) }) },
			'assistant',
			'Agent',
		);

		expect(extension.wrap(Agent)).not.toBe(Agent);
	});

	it('rejects malformed agent cloudflare exports', () => {
		expect(() => resolveCloudflareExtension({ cloudflare: {} }, 'assistant', 'Agent')).toThrow(
			'cloudflare export must be created with extend({ base, wrap })',
		);
	});

	it('rejects malformed base callbacks for agents', () => {
		expect(() =>
			resolveCloudflareExtension(
				{ cloudflare: extend({ base: true as never }) },
				'assistant',
				'Agent',
			),
		).toThrow('cloudflare.base must be a function');
	});

	it('rejects malformed wrap callbacks for agents', () => {
		expect(() =>
			resolveCloudflareExtension(
				{ cloudflare: extend({ wrap: true as never }) },
				'assistant',
				'Agent',
			),
		).toThrow('cloudflare.wrap must be a function');
	});

	it('rejects base callbacks that return unrelated classes for agents', () => {
		const extension = resolveCloudflareExtension(
			{ cloudflare: extend({ base: () => class {} }) },
			'assistant',
			'Agent',
		);

		expect(() => extension.base(Agent)).toThrow(
			'cloudflare.base must return the received class or a subclass',
		);
	});

	it('rejects wrap callbacks that return unrelated classes for agents', () => {
		const extension = resolveCloudflareExtension(
			{ cloudflare: extend({ wrap: () => class {} }) },
			'assistant',
			'Agent',
		);

		expect(() => extension.wrap(Agent)).toThrow(
			'cloudflare.wrap(Final) must return the received class or a constructor proxy',
		);
	});

	it('rejects wrap callbacks that return subclasses for agents', () => {
		const extension = resolveCloudflareExtension(
			{ cloudflare: extend({ wrap: (Final) => class extends Final {} }) },
			'assistant',
			'Agent',
		);

		expect(() => extension.wrap(Agent)).toThrow(
			'cloudflare.wrap(Final) must return the received class or a constructor proxy',
		);
	});

	it('rejects non-constructable prototype-preserving wrappers for agents', () => {
		const extension = resolveCloudflareExtension(
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
			'Agent',
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
		expect(() => extend({ warp: (Final: ExtensionClass) => Final } as never)).toThrow(
			'extend() received unknown option(s): warp',
		);
	});

	it('defaults omitted extension callbacks to identity operations for workflows', () => {
		const extension = resolveCloudflareExtension(
			{ cloudflare: extend({}) },
			'my-workflow',
			'Workflow',
		);

		expect(extension.base(Agent)).toBe(Agent);
		expect(extension.wrap(Agent)).toBe(Agent);
	});

	it('returns identity when no cloudflare export is present for workflows', () => {
		const extension = resolveCloudflareExtension({}, 'my-workflow', 'Workflow');

		expect(extension.base(Agent)).toBe(Agent);
		expect(extension.wrap(Agent)).toBe(Agent);
	});

	it('accepts constructor proxies returned by wrap callbacks for workflows', () => {
		const extension = resolveCloudflareExtension(
			{ cloudflare: extend({ wrap: (Final) => new Proxy(Final, {}) }) },
			'my-workflow',
			'Workflow',
		);

		expect(extension.wrap(Agent)).not.toBe(Agent);
	});

	it('accepts base callbacks that return subclasses for workflows', () => {
		const extension = resolveCloudflareExtension(
			{ cloudflare: extend({ base: (Base) => class extends Base {} }) },
			'my-workflow',
			'Workflow',
		);

		const result = extension.base(Agent);
		expect(result).not.toBe(Agent);
		expect(result.prototype).toBeInstanceOf(Agent);
	});

	it('rejects malformed workflow cloudflare exports', () => {
		expect(() => resolveCloudflareExtension({ cloudflare: {} }, 'my-workflow', 'Workflow')).toThrow(
			'Workflow "my-workflow" cloudflare export must be created with extend({ base, wrap })',
		);
	});

	it('rejects base callbacks that return unrelated classes for workflows', () => {
		const extension = resolveCloudflareExtension(
			{ cloudflare: extend({ base: () => class {} }) },
			'my-workflow',
			'Workflow',
		);

		expect(() => extension.base(Agent)).toThrow(
			'Workflow "my-workflow" cloudflare.base must return the received class or a subclass',
		);
	});

	it('rejects wrap callbacks that return unrelated classes for workflows', () => {
		const extension = resolveCloudflareExtension(
			{ cloudflare: extend({ wrap: () => class {} }) },
			'my-workflow',
			'Workflow',
		);

		expect(() => extension.wrap(Agent)).toThrow(
			'Workflow "my-workflow" cloudflare.wrap(Final) must return the received class or a constructor proxy',
		);
	});
});
