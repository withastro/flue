import type { PromptUsage } from '@flue/sdk';

export type UIMessagePart =
	| { type: 'text'; text: string; state?: 'streaming' | 'done' }
	| { type: 'reasoning'; text: string; state?: 'streaming' | 'done' }
	| ({ type: 'dynamic-tool'; toolName: string; toolCallId: string } & (
			| { state: 'input-available'; input: unknown; output?: never; errorText?: never }
			| { state: 'output-available'; input: unknown; output: unknown; errorText?: never }
			| { state: 'output-error'; input: unknown; output?: never; errorText: string }
	  ))
	| { type: 'file'; mediaType: string; url: string }
	| { type: 'data-attachment'; id: string; data: { mediaType: string; size: number; digest: string } };

// Mirrors UIMessage from ai@5.0.201 packages/ai/src/ui/ui-messages.ts.
export interface UIMessage {
	id: string;
	role: 'user' | 'assistant' | 'system';
	metadata?: {
		usage?: PromptUsage;
		model?: { provider: string; id: string };
		[key: string]: unknown;
	};
	parts: UIMessagePart[];
}
