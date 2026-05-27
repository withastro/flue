// Prompt copied to the user's clipboard by the "Copy Prompt" CTA in the hero.
export const COPY_PROMPT = `fetch https://flueframework.com/start.md to create a new agent`;

export const HERO = `import { createAgent, type AgentRouteHandler, type AgentWebSocketHandler } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import triage from '../skills/triage/SKILL.md' with { type: 'skill' };
import verify from '../skills/verify/SKILL.md' with { type: 'skill' };
import * as githubTools from '../tools/github.ts';

// Give persistent context and autonomy to solve complex tasks:
const instructions = \`
Triage a bug report end-to-end: reproduce the bug,
diagnose the root cause, verify whether the behavior is
intentional, and attempt a fix.

...\`;

// Expose (and protect) your agents over HTTP and WebSockets:
export const route: AgentRouteHandler = async (_c, next) => next();
export const websocket: AgentWebSocketHandler = async (_c, next) => next();

// Compose the complete harness your agent needs to do real work,
// complete with virtual, local, or remote container sandbox.
export default createAgent(() => ({
  model:   'anthropic/claude-sonnet-4-6',
  tools:   [...githubTools],
  skills:  [triage, verify],
  sandbox: local(),
  instructions,
}));`;

