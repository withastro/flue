'use agent';
import { useInstruction, useModel, usePersistentState, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { guarded, useMachine } from '../machine.ts';
import {
	commitApprovedRefund,
	draftEscalation,
	draftReply,
	offerCredit,
	proposeRefund,
	sendReply,
} from '../tools.ts';

interface PhaseProps {
	/** `null` when this phase's tools may run; otherwise the refusal text. */
	check: () => string | null;
	/** The phase's completion tool calls this to advance and announce the move. */
	onComplete: () => string;
}

function useGathering({ check, onComplete }: PhaseProps) {
	useTool({
		name: 'begin_draft',
		description: 'Call once you have enough verified context to draft a response.',
		input: v.object({}),
		run: () => check() ?? onComplete(),
	});
	useInstruction(
		'## Phase: gathering\n\n' +
			'Gather and verify the facts of the case before drafting anything: read the ticket ' +
			'history, confirm the account and order in question, and check for prior promises made ' +
			'to this customer. Do not draft a reply from assumptions — if evidence is missing, ask ' +
			'for it or say so.',
	);
}

function useDrafting({ check, onComplete }: PhaseProps) {
	useTool(guarded(check, draftReply));
	useTool(guarded(check, draftEscalation));
	useTool(guarded(check, proposeRefund));
	useTool({
		name: 'submit_for_execution',
		description:
			'Call once a draft reply, escalation, or refund proposal is ready for operator review.',
		input: v.object({}),
		run: () => check() ?? onComplete(),
	});
	useInstruction(
		'## Phase: drafting\n\n' +
			'Draft the reply, a refund proposal, or an escalation summary — never send or commit ' +
			'anything from this phase. A refund is proposed here and committed, separately, only after ' +
			'operator approval: propose, then commit, never both in one step.',
	);
}

function useCommitting({ check, onComplete }: PhaseProps) {
	useTool(guarded(check, sendReply));
	useTool(guarded(check, commitApprovedRefund));
	useTool({
		name: 'complete',
		description: 'Call once the reply has been sent and any approved refund has been committed.',
		input: v.object({}),
		run: () => check() ?? onComplete(),
	});
	useInstruction(
		'## Phase: committing\n\n' +
			'Only approved work happens here: send the reply that was drafted, and commit a refund ' +
			'only if an operator has approved the proposal by reference. Never invent an approval.',
	);
}

function useDone() {
	useInstruction(
		'## Phase: done\n\n' +
			'The case is closed. Take no further action unless the customer replies again.',
	);
}

function useRetention({ active }: { active: () => boolean }) {
	useTool(
		guarded(
			() => (active() ? null : 'Refused: no churn risk is on record for this case.'),
			offerCredit,
		),
	);
	useInstruction(
		'## Retention\n\n' +
			'Only while the customer is weighing cancellation (sentiment: churn-risk): you may offer ' +
			'a retention credit alongside your normal case work. This is an addition, never a ' +
			'substitute for resolving the underlying issue.',
	);
}

export function Support() {
	useModel('anthropic/claude-sonnet-5');
	const machine = useMachine({
		name: 'phase',
		phases: ['gathering', 'drafting', 'committing', 'done'] as const,
		initial: 'gathering',
	});
	const [sentiment, setSentiment] = usePersistentState<'neutral' | 'churn-risk'>(
		'sentiment',
		'neutral',
	);

	useTool({
		name: 'update_sentiment',
		description: 'Record whether the customer is at risk of churning, based on what they say.',
		input: v.object({ sentiment: v.picklist(['neutral', 'churn-risk']) }),
		run: ({ data }) => {
			setSentiment(data.sentiment);
			return `Sentiment recorded: ${data.sentiment}.`;
		},
	});

	// All phases are always mounted — activation is guards and trust, never
	// control flow. Hook calls are never conditional: the runtime enforces
	// structural invariance across renders and fails the run otherwise.
	useGathering({ check: machine.check('gathering'), onComplete: machine.enter('drafting') });
	useDrafting({ check: machine.check('drafting'), onComplete: machine.enter('committing') });
	useCommitting({ check: machine.check('committing'), onComplete: machine.enter('done') });
	useDone();
	useRetention({ active: () => sentiment === 'churn-risk' });

	return (
		'# Support Agent\n\n' +
		'Operator-facing support agent for a single case. Work only from verified evidence — ' +
		'quote ticket history and account records, never assume. Every phase below is always ' +
		'available to you; move through gathering → drafting → committing → done at your own ' +
		"judgment, calling each phase's completion tool once its work is done. Propose, then " +
		'commit: a refund is never issued in the same step it is proposed.'
	);
}
