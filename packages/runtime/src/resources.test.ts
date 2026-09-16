import { describe, expect, it } from 'vitest';
import { digestInstructions, instructionsChanged, type ResourceSnapshot } from './resources.ts';

describe('instruction digests', () => {
	// SHA-256 vectors over UTF-16LE bytes, independently generated with Python hashlib.
	it.each([
		[undefined, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
		['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
		['abc', '13e228567e8249fce53337f25d7970de3bd68ab2653424c7b8f9fd05e33caedf'],
		['🖍️ e\u0301 \ud800', '75a6c72ea6805b0e5476cc2cfc8a2113366a33a52ccb36bb1b07d6be8b577f98'],
		['\ud800', '205022e3428b7c8276cf247b36e4e512db5651e5cb3472c253d9ee893a8ac750'],
		['\ud801', '4a9868967003d43ddf0f042f7746934a6e27d3464b9b32ac9d93bab42b295696'],
		['\ufffd', '15cc44da5e294721a0fc16c8fb952382d4dc51dbaa28950d9903acfbac0ccee5'],
		['x'.repeat(100_000), '954cbb49c12067ce9534410065a9131e2585cb662cca70720ba08b41b227b5a5'],
	])('returns a synchronous SHA-256 digest (%#)', (instructions, expected) => {
		expect(digestInstructions(instructions)).toBe(expected);
	});

	it('preserves instruction-change detection and adoption of snapshots without a digest', () => {
		const legacy: ResourceSnapshot = { skills: [], tools: [], subagents: [] };
		const first = { ...legacy, instructionsDigest: digestInstructions('first') };
		const same = { ...legacy, instructionsDigest: digestInstructions('first') };
		const changed = { ...legacy, instructionsDigest: digestInstructions('changed') };
		const empty = { ...legacy, instructionsDigest: digestInstructions('') };
		const absent = { ...legacy, instructionsDigest: digestInstructions(undefined) };
		expect(instructionsChanged(first, same)).toBe(false);
		expect(instructionsChanged(first, changed)).toBe(true);
		expect(instructionsChanged(changed, empty)).toBe(true);
		expect(instructionsChanged(empty, absent)).toBe(false);
		expect(instructionsChanged(legacy, changed)).toBe(false);
	});
});
