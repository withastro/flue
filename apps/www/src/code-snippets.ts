// Prompt copied to the user's clipboard by the "Copy Prompt" CTA in the hero.
export const COPY_PROMPT = `Read https://flueframework.com/start.md then help create my first agent...`;

export const HERO = `import { defineAgent } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import triage from '../skills/triage/SKILL.md' with { type: 'skill' };
import verify from '../skills/verify/SKILL.md' with { type: 'skill' };
import { replyToIssue } from '../tools/github.ts';

// Expose (and protect) your agents to the world:
export const route = (c, next) => next();

// Give agents the autonomy to solve complex tasks:
const instructions = \`
Triage a bug report end-to-end: reproduce the bug,
diagnose the root cause, verify whether the behavior is
intentional, and attempt a fix.\`;

// Compose the context your agent needs to do real work,
// complete with virtual, local, or remote container sandbox.
export default defineAgent(() => ({
  model:   'anthropic/claude-sonnet-4-6',
  tools:   [replyToIssue],
  skills:  [triage, verify],
  sandbox: local(),
  instructions,
}));`;
