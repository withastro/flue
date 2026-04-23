/**
 * Node-specific entry point for `@flue/sdk`. Currently exports the Node
 * implementation of `defineCommand`.
 *
 * Import platform-agnostic types (`FlueContext`, `Command`, etc.) from
 * `@flue/sdk/client`.
 */
export { defineCommand, type CommandOptions } from './define-command.ts';
