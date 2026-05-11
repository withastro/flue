import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isBashLike } from './sandbox.ts';

const validBashLike = {
	exec: () => ({ stdout: '', stderr: '', exitCode: 0 }),
	getCwd: () => '/tmp',
	fs: {
		readFile: () => '',
		writeFile: () => {},
		resolvePath: (a: string, b: string) => `${a}/${b}`,
	},
};

describe('isBashLike', () => {
	it('accepts an object with the required bash-like shape', () => {
		assert.equal(isBashLike(validBashLike), true);
	});

	it('rejects null', () => {
		assert.equal(isBashLike(null), false);
	});

	it('rejects undefined', () => {
		assert.equal(isBashLike(undefined), false);
	});

	it('rejects primitive values', () => {
		assert.equal(isBashLike('bash'), false);
		assert.equal(isBashLike(42), false);
		assert.equal(isBashLike(true), false);
	});

	it('rejects objects missing exec', () => {
		const { exec: _exec, ...withoutExec } = validBashLike;
		assert.equal(isBashLike(withoutExec), false);
	});

	it('rejects objects missing getCwd', () => {
		const { getCwd: _getCwd, ...withoutGetCwd } = validBashLike;
		assert.equal(isBashLike(withoutGetCwd), false);
	});

	it('rejects objects missing fs', () => {
		const { fs: _fs, ...withoutFs } = validBashLike;
		assert.equal(isBashLike(withoutFs), false);
	});

	it('rejects objects whose exec is not a function', () => {
		assert.equal(isBashLike({ ...validBashLike, exec: 'bash' }), false);
	});

	it('rejects objects whose getCwd is not a function', () => {
		assert.equal(isBashLike({ ...validBashLike, getCwd: '/tmp' }), false);
	});

	it('rejects objects whose fs is null', () => {
		// Regression: `typeof null === 'object'`, so a naive typeof check without an
		// explicit null guard mistakenly accepts `{ ..., fs: null }`. A bash-like
		// object with a null fs is unusable — the caller would crash on the first
		// fs.readFile() call instead of failing fast at assertion time.
		assert.equal(isBashLike({ ...validBashLike, fs: null }), false);
	});

	it('rejects objects whose fs is a primitive', () => {
		assert.equal(isBashLike({ ...validBashLike, fs: 'filesystem' }), false);
	});
});
