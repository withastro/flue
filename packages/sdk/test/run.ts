/**
 * Minimal test runner.
 *
 * Why not `node --test 'test/**\/*.test.ts'`?
 * Node 22's `--test` flag spawns each file as a subprocess and, combined
 * with `--experimental-transform-types`, silently drops `describe` blocks
 * that import heavy modules transitively (observed: any file that imports
 * `src/session.ts` registers zero subtests and reports a fake "ok 1").
 * Running through `run()` in-process avoids the subprocess isolation bug.
 */

import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { pipeline } from 'node:stream/promises';

const here = dirname(fileURLToPath(import.meta.url));

const files = readdirSync(here)
	.filter((name) => name.endsWith('.test.ts'))
	.map((name) => join(here, name));

let failed = false;

const testStream = run({ files, concurrency: false });

testStream.on('test:fail', (event) => {
	// Internal diagnostic events (e.g. counters) fire as `test:fail` too but
	// carry `todo` flags; treat anything without `todo` as a real failure.
	if (!event.todo) failed = true;
});

await pipeline(testStream.compose(spec), process.stdout);

process.exit(failed ? 1 : 0);
