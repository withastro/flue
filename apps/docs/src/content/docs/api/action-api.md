---
title: Action API
description: Reference for defining reusable finite Actions with @flue/runtime.
lastReviewedAt: 2026-06-19
---

The Action API is exported from `@flue/runtime`.

## `defineAction()`

```ts
function defineAction<TInput, TOutput>(
  options: ActionOptions<TInput, TOutput>,
): ActionDefinition<TInput, TOutput>;
```

Defines reusable finite behavior. The returned frozen value can be bound to a workflow with `defineWorkflow({ agent, action })` or exposed to a model through an agent's `actions` field.

### Options

| Field         | Required | Description                                                                                  |
| ------------- | -------- | -------------------------------------------------------------------------------------------- |
| `name`        | Yes      | Non-empty model-facing tool name. Must not conflict with another active tool or Action name. |
| `description` | Yes      | Non-empty model-facing description.                                                          |
| `input`       | No       | Top-level object Valibot schema.                                                             |
| `output`      | No       | Valibot schema for the returned value.                                                       |
| `run`         | Yes      | Finite handler receiving `ActionContext`.                                                    |

Definition rejects missing metadata, non-Valibot schemas, and input schemas whose top level is not an object. Inline `defineWorkflow({ run })` definitions delegate these schema checks to `defineAction()` and report the same errors.

## `ActionContext`

```ts
type ActionContext<S> = {
  readonly harness: FlueHarness;
  readonly log: FlueLogger;
} & (S extends ActionInputSchema ? { readonly input: InferOutput<S> } : {});
```

| Member    | Description                                                                                   |
| --------- | --------------------------------------------------------------------------------------------- |
| `harness` | Invocation-scoped harness supplied by the runner.                                             |
| `input`   | Parsed and transformed schema output. Omitted from the type when no input schema is declared. |
| `log`     | Structured logger for the current execution.                                                  |

Action context intentionally excludes transport requests, platform bindings, and workflow identity. Pass required data through input and configure capabilities on the agent.

When a model calls an Action, Flue runs it in an isolated child scope. The child shares the parent agent configuration, sandbox, and filesystem, but has independent default and named sessions and cannot reenter the active parent session. Its canonical records remain append-only in the agent-instance stream for that instance's lifetime; there is no recursive per-session deletion.

## Input and output contracts

Input is validated before `run()` executes. Output is validated after `run()` when an output schema exists. Valibot transformations are reflected in the values received and returned.

Without an output schema, an Action may return any JSON-serializable value or `undefined`. With an output schema, the parsed result must be JSON-serializable and cannot be `undefined` unless the schema produces a serializable value.

## Utility types

```ts
type ActionInput<TAction extends ActionDefinition> = /* schema input type */;
type ActionOutput<TAction extends ActionDefinition> = /* schema output type */;
type ActionInputSchema = GenericSchema<Record<string, unknown>, unknown>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
```

`ActionInput<TAction>` is the authored schema input type. `ActionOutput<TAction>` is the parsed output type, or `unknown` when no output schema is declared.

## Errors

| Error                            | `type`                        | Contract                                                                      |
| -------------------------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| `ActionInputValidationError`     | `action_input_validation`     | Input failed schema parsing. `meta` contains `action` and `issues`.           |
| `ActionOutputValidationError`    | `action_output_validation`    | Returned output failed schema parsing. `meta` contains `action` and `issues`. |
| `ActionOutputSerializationError` | `action_output_serialization` | Final output was not JSON-serializable. `meta.action` identifies it.          |

Validation issues use the exported `ValidationIssue` shape with `message` and an optional property-key `path`.
