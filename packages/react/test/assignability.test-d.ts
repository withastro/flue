import type { UIMessage as AiUIMessage } from 'ai';
import type { UIMessage } from '../src/types.ts';

declare const messages: UIMessage[];
const aiMessages: AiUIMessage[] = messages;
void aiMessages;
