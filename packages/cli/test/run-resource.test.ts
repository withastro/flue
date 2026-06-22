import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveRunResource } from '../src/lib/run-resource.ts';

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function project(files: string[]): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-resource-'));
	roots.push(root);
	for (const file of files) {
		const filePath = path.join(root, '.flue', file);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, 'export default {};');
	}
	return path.join(root, '.flue');
}

describe('resolveRunResource()', () => {
	it('resolves a unique resource using source-root discovery', () => {
		const root = project(['agents/support.ts']);

		expect(resolveRunResource(root, 'support')).toMatchObject({ kind: 'agent', name: 'support' });
	});

	it('requires a qualifier when an agent and workflow share a name', () => {
		const root = project(['agents/report.ts', 'workflows/report.ts']);

		expect(() => resolveRunResource(root, 'report')).toThrow(
			'Qualify it as agent:report or workflow:report',
		);
		expect(resolveRunResource(root, 'workflow:report')).toMatchObject({
			kind: 'workflow',
			name: 'report',
		});
	});

	it('reports sorted qualified resources when a resource is missing', () => {
		const root = project(['agents/zeta.ts', 'workflows/alpha.ts']);

		expect(() => resolveRunResource(root, 'missing')).toThrow(
			'Available resources:\n  agent:zeta\n  workflow:alpha',
		);
	});
});
