import { afterEach, describe, expect, it } from 'vitest';
import type { EventStreamStore } from '../runtime/event-stream-store.ts';

export interface EventStreamStoreContractBackend {
	create(): EventStreamStore | Promise<EventStreamStore>;
	cleanup?(): void | Promise<void>;
}

export function defineEventStreamStoreContractTests(
	label: string,
	backend: EventStreamStoreContractBackend,
): void {
	describe(label, () => {
		let cleanup: (() => void | Promise<void>) | undefined;

		async function create(): Promise<EventStreamStore> {
			cleanup = backend.cleanup;
			return backend.create();
		}

		afterEach(async () => {
			await cleanup?.();
			cleanup = undefined;
		});

		it('replays appended events with monotonic offsets', async () => {
			const store = await create();
			await store.createStream('runs/test');
			const first = await store.appendEvent('runs/test', { index: 0 });
			const second = await store.appendEvent('runs/test', { index: 1 });

			expect(first).toBe('0000000000000000_0000000000000000');
			expect(second).toBe('0000000000000000_0000000000000001');
			expect(await store.readEvents('runs/test', { offset: '-1' })).toMatchObject({
				events: [
					{ data: { index: 0 }, offset: first },
					{ data: { index: 1 }, offset: second },
				],
				nextOffset: second,
				upToDate: true,
				closed: false,
			});
		});

		it('rejects appends after a stream closes', async () => {
			const store = await create();
			await store.createStream('runs/test');
			await store.appendEvent('runs/test', { index: 0 });
			await store.closeStream('runs/test');

			await expect(store.appendEvent('runs/test', { index: 1 })).rejects.toThrow('closed');
			expect(await store.getStreamMeta('runs/test')).toEqual({
				nextOffset: '0000000000000000_0000000000000000',
				closed: true,
			});
		});

		it('notifies subscribers on append and close', async () => {
			const store = await create();
			await store.createStream('runs/test');
			let notifications = 0;
			const unsubscribe = store.subscribe('runs/test', () => {
				notifications++;
			});

			await store.appendEvent('runs/test', { index: 0 });
			await store.closeStream('runs/test');
			unsubscribe();

			expect(notifications).toBe(2);
		});

		it('pages through a stream and reports the tail', async () => {
			const store = await create();
			await store.createStream('runs/test');
			for (let index = 0; index < 3; index++) {
				await store.appendEvent('runs/test', { index });
			}

			const firstPage = await store.readEvents('runs/test', { offset: '-1', limit: 2 });
			expect(firstPage).toMatchObject({
				events: [{ data: { index: 0 } }, { data: { index: 1 } }],
				nextOffset: '0000000000000000_0000000000000001',
				upToDate: false,
			});
			const secondPage = await store.readEvents('runs/test', { offset: firstPage.nextOffset, limit: 2 });
			expect(secondPage).toMatchObject({
				events: [{ data: { index: 2 } }],
				nextOffset: '0000000000000000_0000000000000002',
				upToDate: true,
			});
		});

		it('marks an exactly-limit page ending at the tail as up to date', async () => {
			const store = await create();
			await store.createStream('runs/test');
			for (let index = 0; index < 4; index++) {
				await store.appendEvent('runs/test', { index });
			}

			const partial = await store.readEvents('runs/test', { offset: '-1', limit: 2 });
			expect(partial.upToDate).toBe(false);

			const exact = await store.readEvents('runs/test', { offset: partial.nextOffset, limit: 2 });
			expect(exact).toMatchObject({
				events: [{ data: { index: 2 } }, { data: { index: 3 } }],
				nextOffset: '0000000000000000_0000000000000003',
				upToDate: true,
			});
		});

		it('returns null metadata for missing streams', async () => {
			const store = await create();
			expect(await store.getStreamMeta('runs/missing')).toBeNull();
		});
	});
}
