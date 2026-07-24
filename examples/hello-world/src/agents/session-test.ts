'use agent';
import { useModel } from '@flue/runtime';

export function SessionTest() {
	// The legacy profile declared no model of its own; picking a low-cost
	// default here since every agent must declare one via useModel.
	useModel('anthropic/claude-haiku-4-5');
	return 'You are a test agent for session-oriented message delivery.';
}
