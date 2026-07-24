'use agent';
import { useModel, useSubagent } from '@flue/runtime';

function Greeter() {
	return 'Write one warm, concise greeting.';
}

export function WithSubagent() {
	useModel('anthropic/claude-sonnet-4-6');
	useSubagent({
		name: 'greeter',
		description: 'Writes a short, warm greeting for a named user.',
		agent: Greeter,
	});
	return 'When asked to greet someone, delegate the greeting to the `greeter` subagent and report its greeting verbatim.';
}
