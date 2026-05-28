import { readJsonResponse, type FetchLike } from './http.ts';

export type JiraHistorySource = 'auto' | 'pr' | 'jira' | 'both';

export interface JiraAutomationConfig {
	baseUrl?: string;
	fetchImpl?: FetchLike;
}

export interface JiraHistoryQueryInput extends JiraAutomationConfig {
	question: string;
	source?: JiraHistorySource;
	repo?: string;
	startDate?: string;
	endDate?: string;
	limit?: number;
}

export interface JiraScopeInput extends JiraAutomationConfig {
	product?: string;
	squad?: string;
}

export interface JiraCreateTicketInput extends JiraAutomationConfig {
	summary: string;
	description: string;
	project?: string;
	issueType?: string;
	confirmed?: boolean;
}

export interface JiraCreatePrInput extends JiraAutomationConfig {
	repo: string;
	title: string;
	head: string;
	body: string;
}

const DEFAULT_JIRA_AUTOMATION_URL = 'https://jira-automation-api.apps.evenup.law';

export async function getJiraTaxonomy(input: JiraAutomationConfig = {}) {
	return getJson(input, '/knowledge/taxonomy');
}

export async function getJiraScope(input: JiraScopeInput) {
	if ((!input.product && !input.squad) || (input.product && input.squad)) {
		throw new Error('Provide exactly one of product or squad.');
	}
	const params = input.product
		? new URLSearchParams({ product: input.product })
		: new URLSearchParams({ squad: input.squad! });
	const path = input.product ? '/knowledge/product-scope' : '/knowledge/squad-scope';
	return getJson(input, `${path}?${params}`);
}

export async function queryJiraHistory(input: JiraHistoryQueryInput) {
	const payload: Record<string, unknown> = {
		question: input.question,
		source: input.source ?? 'auto',
		limit: input.limit ?? 50,
	};
	if (input.repo) payload.repo = input.repo;
	if (input.startDate) payload.start_date = input.startDate;
	if (input.endDate) payload.end_date = input.endDate;
	return postJson(input, '/query', payload);
}

export async function createJiraTicket(input: JiraCreateTicketInput) {
	return postJson(input, '/create-ticket', {
		summary: input.summary,
		description: input.description,
		project: input.project ?? 'DA',
		issue_type: input.issueType ?? 'Task',
		confirmed: input.confirmed ?? true,
	});
}

export async function createJiraPr(input: JiraCreatePrInput) {
	return postJson(input, '/create-pr', {
		repo: input.repo,
		title: input.title,
		head: input.head,
		body: input.body,
	});
}

async function getJson(input: JiraAutomationConfig, path: string) {
	const fetcher = input.fetchImpl ?? fetch;
	const response = await fetcher(`${baseUrl(input.baseUrl)}${path}`);
	return readJsonResponse(response, 'jira-automation-api');
}

async function postJson(input: JiraAutomationConfig, path: string, payload: Record<string, unknown>) {
	const fetcher = input.fetchImpl ?? fetch;
	const response = await fetcher(`${baseUrl(input.baseUrl)}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});
	return readJsonResponse(response, 'jira-automation-api');
}

function baseUrl(value?: string): string {
	return (value || process.env.JIRA_AUTOMATION_API_URL || DEFAULT_JIRA_AUTOMATION_URL).replace(/\/+$/, '');
}
