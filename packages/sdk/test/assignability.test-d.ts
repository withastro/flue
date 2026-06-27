import {
	IMAGE_DATA_OMITTED as RUNTIME_IMAGE_DATA_OMITTED,
	type FlueEvent as RuntimeFlueEvent,
	type LlmMessage as RuntimeLlmMessage,
	type ModelRequestInfo as RuntimeModelRequestInfo,
	type PromptResponse as RuntimePromptResponse,
	type PromptUsage as RuntimePromptUsage,
	type RunRecord as RuntimeRunRecord,
} from '@flue/runtime';
import {
	type AgentPromptResponse,
	IMAGE_DATA_OMITTED as SDK_IMAGE_DATA_OMITTED,
	type FlueEvent as SdkFlueEvent,
	type LlmMessage as SdkLlmMessage,
	type ModelRequestInfo as SdkModelRequestInfo,
	type PromptUsage as SdkPromptUsage,
	type RunRecord as SdkRunRecord,
} from '../src/index.ts';

// `turn_request` is in-process only (`observe()` subscribers and exporters);
// it is never persisted to durable streams or served over HTTP, so the SDK
// wire union deliberately omits it.
type MessageSnapshotEvent = { type: 'message_start' | 'message_end' };
type CheckpointOneSettlementEvent = { type: 'submission_settled' };
const _: Exclude<SdkFlueEvent, MessageSnapshotEvent | CheckpointOneSettlementEvent> = {} as Exclude<
	RuntimeFlueEvent,
	{ type: 'turn_request' } | MessageSnapshotEvent | CheckpointOneSettlementEvent
>;
void _;

const _snapshot: Extract<SdkFlueEvent, MessageSnapshotEvent>['message'] = {} as RuntimeLlmMessage;
const _snapshotTurnId: Extract<SdkFlueEvent, MessageSnapshotEvent>['turnId'] = {} as Extract<
	RuntimeFlueEvent,
	MessageSnapshotEvent
>['turnId'];
void _snapshot;
void _snapshotTurnId;

type _SettlementResult = Extract<
	SdkFlueEvent,
	CheckpointOneSettlementEvent
>['result'];
type _SettlementError = Extract<
	SdkFlueEvent,
	CheckpointOneSettlementEvent
>['error'];
const _settlementResult: _SettlementResult = {} as unknown;
const _settlementError: _SettlementError = { message: 'failed' };
void _settlementResult;
void _settlementError;

type ExpectNever<T extends never> = T;
type _SdkMessageUpdateIsAbsent = ExpectNever<Extract<SdkFlueEvent, { type: 'message_update' }>>;
type _RuntimeMessageUpdateIsAbsent = ExpectNever<
	Extract<RuntimeFlueEvent, { type: 'message_update' }>
>;

// Direct-agent prompts (`?wait=result`) always resolve with the runtime
// `PromptResponse`; the SDK duplicates the shape so it must stay assignable.
const _prompt: AgentPromptResponse = {} as RuntimePromptResponse;
void _prompt;

// The SDK duplicates `PromptUsage`; the shapes must stay mutually assignable.
const _usage: SdkPromptUsage = {} as RuntimePromptUsage;
const _usageBack: RuntimePromptUsage = {} as SdkPromptUsage;
void _usage;
void _usageBack;

const _message: SdkLlmMessage = {} as RuntimeLlmMessage;
const _messageBack: RuntimeLlmMessage = {} as SdkLlmMessage;
void _message;
void _messageBack;

const _modelRequestInfo: SdkModelRequestInfo = {} as RuntimeModelRequestInfo;
const _modelRequestInfoBack: RuntimeModelRequestInfo = {} as SdkModelRequestInfo;
void _modelRequestInfo;
void _modelRequestInfoBack;

// `GET /runs/:id?meta` serves the runtime `RunRecord`; the SDK duplicates the
// shape with no intentional widening, so it must stay mutually assignable.
const _run: SdkRunRecord = {} as RuntimeRunRecord;
const _runBack: RuntimeRunRecord = {} as SdkRunRecord;
void _run;
void _runBack;

// The SDK duplicates the image-redaction sentinel; both constants are literal
// string types, so these assignments fail if the values ever diverge.
const _sentinel: typeof RUNTIME_IMAGE_DATA_OMITTED = SDK_IMAGE_DATA_OMITTED;
const _sentinelBack: typeof SDK_IMAGE_DATA_OMITTED = RUNTIME_IMAGE_DATA_OMITTED;
void _sentinel;
void _sentinelBack;
