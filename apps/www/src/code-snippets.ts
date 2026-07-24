// Prompt copied to the user's clipboard by the "Copy Prompt" CTA in the hero.
export const COPY_PROMPT = `Read https://flueframework.com/start.md then help create my first agent...`;

export const HERO = `'use agent';
import { useModel, usePersistentState, useSandbox, useSkill, useTool } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import triage from '../skills/triage/SKILL.md';

// This is an agent.
export function IssueTriage() {
  // Define your agent with hooks.
  // Dynamically attach capabilities to your agent.
  useModel('anthropic/claude-sonnet-5-0');
  useSkill(triage);
  // Store persistent data on each agent.
  // Update your agent capabilities as state evolves.
  const [isSandbox, setSandbox] = usePersistentState('isSandbox', false);
  useTool({name: 'handoff', description: '...', run: () => setSandbox(true)});
  if (isSandbox) useSandbox(local());
  // Return your agent instructions. Flue handles the rest.
  return \`Triage the bug report end-to-end...\`;
}`;
