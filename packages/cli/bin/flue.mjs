#!/usr/bin/env node
// @ts-nocheck

/**
 * `flue` bin entrypoint.
 *
 * This file runs on the user's Node — including UNSUPPORTED versions — so it
 * must use only universally-available JavaScript. It is NOT compiled (no TS,
 * no bundler), and ships as-is via the `files` array in package.json. Its
 * single job is to validate the runtime before handing off to the real CLI in
 * `../dist/flue.js`, which is allowed to assume modern Node.
 *
 * Modeled on Astro's `bin/astro.mjs`. We deliberately avoid the `semver`
 * dependency by hand-rolling a simple major.minor comparison — the supported
 * range is a flat lower bound, not an arbitrary semver expression.
 */

// Hardcode the supported floor here AND in package.json. Two places is
// deliberate: this file must be parseable by any Node version, so we can't
// read package.json with `import { ... } from '../package.json' with { type: 'json' }`
// (that's a recent feature) and don't want to fall back to fs+JSON.parse for
// what's essentially a build-time constant.
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 18;
const ENGINES_LABEL = '>=22.18';

function checkNodeVersion() {
	const v = process.versions.node;
	const m = /^(\d+)\.(\d+)/.exec(v);
	if (!m) return; // unparseable; let it through and let the real CLI fail loudly
	const major = parseInt(m[1], 10);
	const minor = parseInt(m[2], 10);
	if (major > MIN_NODE_MAJOR) return;
	if (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR) return;

	console.error(
		'\nNode.js v' +
			v +
			' is not supported by Flue.\n' +
			'Flue requires Node.js ' +
			ENGINES_LABEL +
			' (or any newer major) for native TypeScript config support.\n' +
			'Please upgrade: https://nodejs.org/\n',
	);
	process.exit(1);
}

checkNodeVersion();

// Hand off to the real CLI. Dynamic import keeps this file syntactically
// reachable on older Node — the failure path above always wins on those.
import('../dist/flue.js').catch((err) => {
	console.error(err);
	process.exit(1);
});
