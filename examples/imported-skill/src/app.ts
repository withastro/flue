import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { WithCustomBash } from './agents/with-custom-bash.ts';
import { WithImportedSkill } from './agents/with-imported-skill.ts';

const app = new Hono();
app.route('/agents/with-imported-skill', createAgentRouter(WithImportedSkill));
app.route('/agents/with-custom-bash', createAgentRouter(WithCustomBash));

export default app;
