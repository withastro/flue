'use agent';
import { useModel } from '@flue/runtime';

export function Scheduled() {
	useModel('anthropic/claude-sonnet-4-6');
	return 'Complete scheduled tasks autonomously.';
}
