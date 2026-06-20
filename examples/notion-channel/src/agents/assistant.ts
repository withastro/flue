import { defineAgent } from '@flue/runtime';
import { pageIdFromInstanceId, retrievePage } from '../channels/notion.ts';

export default defineAgent(({ id }) => {
	const pageId = pageIdFromInstanceId(id);
	return {
		model: 'anthropic/claude-haiku-4-5',
		instructions:
			'Review the Notion page change. Retrieve the current page when its properties are needed.',
		tools: [retrievePage(pageId)],
	};
});
