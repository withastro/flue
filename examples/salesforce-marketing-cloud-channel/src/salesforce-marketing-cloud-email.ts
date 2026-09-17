import type { SalesforceMarketingCloudEvent } from '@flue/salesforce';

const EMAIL_EVENT_INSTANCE_PREFIX = 'salesforce-marketing-cloud-email:';

export interface SalesforceMarketingCloudEmailRef {
	callbackId: string;
	mid: string;
	eid: string;
	jobId: string;
	batchId: string;
	listId: string;
	subscriberId: string;
}

export function emailRefFromEvent(
	callbackId: string,
	event: SalesforceMarketingCloudEvent,
): SalesforceMarketingCloudEmailRef | undefined {
	if (!isNonEmptyTrimmedString(callbackId)) return undefined;
	const mid = decimalId(event.mid);
	const eid = decimalId(event.eid);
	const composite = event.composite;
	if (!mid || !eid || !isRecord(composite)) return undefined;
	if (
		!isPositiveDecimal(composite.jobId) ||
		!isPositiveDecimal(composite.batchId) ||
		!isPositiveDecimal(composite.listId) ||
		!isPositiveDecimal(composite.subscriberId)
	) {
		return undefined;
	}
	return {
		callbackId,
		mid,
		eid,
		jobId: composite.jobId,
		batchId: composite.batchId,
		listId: composite.listId,
		subscriberId: composite.subscriberId,
	};
}

export function emailEventInstanceId(ref: SalesforceMarketingCloudEmailRef): string {
	validateEmailRef(ref);
	const canonical: SalesforceMarketingCloudEmailRef = {
		callbackId: ref.callbackId,
		mid: ref.mid,
		eid: ref.eid,
		jobId: ref.jobId,
		batchId: ref.batchId,
		listId: ref.listId,
		subscriberId: ref.subscriberId,
	};
	return `${EMAIL_EVENT_INSTANCE_PREFIX}${encodeURIComponent(JSON.stringify(canonical))}`;
}

function validateEmailRef(value: unknown): asserts value is SalesforceMarketingCloudEmailRef {
	if (
		!isRecord(value) ||
		!isNonEmptyTrimmedString(value.callbackId) ||
		!isPositiveDecimal(value.mid) ||
		!isPositiveDecimal(value.eid) ||
		!isPositiveDecimal(value.jobId) ||
		!isPositiveDecimal(value.batchId) ||
		!isPositiveDecimal(value.listId) ||
		!isPositiveDecimal(value.subscriberId)
	) {
		throw new TypeError('Salesforce Marketing Cloud email reference is invalid.');
	}
}

function decimalId(value: unknown): string | undefined {
	if (typeof value === 'number') {
		return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
	}
	return isPositiveDecimal(value) ? value : undefined;
}

function isPositiveDecimal(value: unknown): value is string {
	return typeof value === 'string' && /^[1-9]\d*$/.test(value);
}

function isNonEmptyTrimmedString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
