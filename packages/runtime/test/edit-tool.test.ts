import { describe, expect, it, vi } from 'vitest';
import { createTools } from '../src/agent.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

describe('createTools()', () => {
	it('rejects an edit when oldText is empty', async () => {
		const env = createNoopSessionEnv({ readFile: async () => 'file content' });
		const edit = createTools(env).find((tool) => tool.name === 'edit');

		await expect(
			edit?.execute('call', { path: 'a.txt', oldText: '', newText: 'inserted' }),
		).rejects.toThrow('oldText must be a non-empty string');
	});

	// newText is the replacement argument to String.prototype.replace, which
	// interprets `$` tokens — `$` before a backtick means "the text before the
	// match", so a newText carrying that sequence expands to the file's prefix
	// instead of being inserted verbatim.
	it('inserts newText verbatim when it contains a `$` replacement token', async () => {
		const writeFile = vi.fn(async () => {});
		const env = createNoopSessionEnv({
			readFile: async () => 'first line\nsecond line\n\ntarget line',
			writeFile,
		});
		const edit = createTools(env).find((tool) => tool.name === 'edit');

		await edit?.execute('call', {
			path: 'a.txt',
			oldText: 'target line',
			newText: 'target line with a $` token appended',
		});

		expect(writeFile).toHaveBeenCalledWith(
			'a.txt',
			'first line\nsecond line\n\ntarget line with a $` token appended',
		);
	});

	it('returns the filesystem error when reading a directory', async () => {
		const env = createNoopSessionEnv({
			readFile: async () => {
				throw new Error('EISDIR: illegal operation on a directory, read');
			},
			stat: async () => {
				throw new Error('stat should not be called');
			},
		});
		const read = createTools(env).find((tool) => tool.name === 'read');

		await expect(read?.execute('call', { path: 'directory' })).rejects.toThrow(
			'EISDIR: illegal operation on a directory, read',
		);
	});
});
