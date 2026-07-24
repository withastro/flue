'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { retrievePage } from '../channels/notion.ts';

const initialDataSchema = v.object({
	pageId: v.string(),
});

export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) throw new Error('This agent is created by the Notion channel dispatch.');
	useTool(retrievePage(data.pageId));
	return 'Review the Notion page change. Retrieve the current page when its properties are needed.';
}

Assistant.initialData = initialDataSchema;
