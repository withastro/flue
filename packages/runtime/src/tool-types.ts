import type * as v from 'valibot';

/**
 * Schema for a custom tool's arguments: a valibot object schema for
 * hand-written tools, or a raw JSON Schema document object as the interop
 * escape hatch — schemas discovered from adapters such as MCP, or produced by
 * other schema libraries (e.g. TypeBox schemas are structurally JSON Schema),
 * pass through unchanged. The raw arm is intentionally `object`: JSON Schema
 * documents have no useful structural type, and schema-builder outputs are
 * interfaces that narrower record types would reject.
 */
export type ToolParameters = v.GenericSchema | object;

/**
 * Arguments delivered to a tool's `execute` callback. Valibot schemas yield
 * their parsed output type; raw JSON Schema parameters yield an untyped
 * record.
 */
export type ToolArgs<TParams extends ToolParameters> = [TParams] extends [v.GenericSchema]
	? v.InferOutput<TParams>
	: Record<string, any>;

/**
 * Custom tool passed to defineAgent(), init(), prompt(), skill(), or task().
 * Agent and init tools are available to every session call; prompt/skill/task
 * tools are scoped to that call.
 * Build `parameters` with valibot (`v.object({ ... })`), or pass a raw JSON
 * Schema object for schemas produced elsewhere.
 */
export interface ToolDefinition<TParams extends ToolParameters = ToolParameters> {
	/** Must be unique across built-in and custom tools. */
	name: string;
	/** Tells the LLM when and how to use this tool. */
	description: string;
	/** Valibot object schema or raw JSON Schema object. */
	parameters: TParams;
	/** Returns a string result sent back to the LLM. Thrown errors become tool errors. */
	execute: (args: ToolArgs<TParams>, signal?: AbortSignal) => Promise<string>;
}
