import type { CAC } from 'cac';

/** cac's help-callback section shape (not exported from the package). */
interface HelpSection {
	title?: string;
	body: string;
}

/**
 * Post-process cac's auto-generated help. The epilogue notes are appended to
 * the global help only (the one listing Commands), not per-command help.
 */
export function helpCallback(sections: HelpSection[]): HelpSection[] {
	if (sections.some((section) => section.title === 'Commands')) {
		sections.push({
			body:
				'Dev servers and production builds are owned by Vite (`vite dev` / `vite build`\n' +
				'with the `flue()` plugin from @flue/vite in vite.config.ts).\n\n' +
				"Set the model with `useModel('provider-id/model-id')` in the agent function\n" +
				'or per-call `{ model: ... }` on prompt/skill/task.',
		});
	}
	return sections;
}

/**
 * cac prints help through `console.info` (stdout). Error paths (unknown or
 * missing command) must keep stdout clean — it is reserved for
 * machine-readable payloads — so reroute the one call to stderr.
 */
export function printHelpToStderr(cli: CAC): void {
	const original = console.info;
	console.info = console.error;
	try {
		cli.outputHelp();
	} finally {
		console.info = original;
	}
}
