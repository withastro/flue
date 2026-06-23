import { Box, render, Static, Text, useApp, useInput, usePaste } from 'ink';
import TextInput from 'ink-text-input';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ConsoleController, ConsoleQueuedPrompt } from './console-controller.ts';
import { boundedShutdown } from './console-shutdown.ts';
import { type TranscriptRecord, transcriptDisplayRecords } from './console-transcript.ts';

export function ConsoleUi({ controller }: { controller: ConsoleController }) {
	const { exit } = useApp();
	const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
	const [draft, setDraft] = useState('');
	const [closing, setClosing] = useState(false);
	const pending = useMemo(
		() => transcriptDisplayRecords(snapshot.transcript).slice(snapshot.transcript.records.length),
		[snapshot.transcript],
	);

	useEffect(() => {
		if (snapshot.status === 'closed' || snapshot.status === 'detached') exit();
	}, [exit, snapshot.status]);

	const close = (exitCode?: number) => {
		if (closing) return;
		if (exitCode !== undefined) process.exitCode = exitCode;
		setClosing(true);
		void boundedShutdown({
			close: () => controller.close(),
			forceCloseSync: () => controller.forceCloseSync(),
			exitCode: exitCode ?? 0,
			beforeTerminate: exit,
		}).then(
			() => exit(),
			() => setClosing(false),
		);
	};
	useInput((input, key) => {
		if (key.ctrl && input === 'c') {
			close(130);
			return;
		}
		if (key.escape) close();
	});
	usePaste((text) => {
		if (!snapshot.composerEnabled || closing) return;
		setDraft((value) => `${value}${text.replace(/[\r\n]+/g, ' ')}`);
	});

	const subject = snapshot.resource
		? `${snapshot.resource.kind} ${snapshot.resource.name}${snapshot.id ? `  ${snapshot.id}` : ''}`
		: 'validating resource';
	const status = closing ? 'closing' : snapshot.active ? 'prompt active' : snapshot.status;

	return (
		<>
			<Static items={[...snapshot.transcript.records]}>
				{(record) => <TranscriptLine key={record.id} record={record} />}
			</Static>
			{pending.map((record) => <TranscriptLine key={record.id} record={record} />)}
			{snapshot.queuedPrompts.length > 0 ? <QueuedPrompts prompts={snapshot.queuedPrompts} /> : null}
			<Box marginTop={1}>
				<Text dimColor>{subject}</Text>
				<Text dimColor>  ·  </Text>
				<Text color={snapshot.status === 'failed' ? 'red' : snapshot.active ? 'yellow' : 'green'}>{status}</Text>
			</Box>
			{snapshot.resource?.kind === 'agent' ? (
				<Box borderStyle="round" borderColor={snapshot.status === 'failed' ? 'red' : 'blue'} paddingX={1}>
					<Text color="blue">› </Text>
					{snapshot.composerEnabled && !closing ? (
						<TextInput
							value={draft}
							onChange={(value) => setDraft(value.replace(/[\r\n]+/g, ' '))}
							onSubmit={(value) => {
								const message = value.trim();
								if (!message) return;
								setDraft('');
								submitConsoleMessage(controller, message);
							}}
							placeholder={snapshot.active ? 'Send another message' : 'Message agent'}
						/>
					) : <Text dimColor>{closing ? 'Closing' : snapshot.active ? 'Prompt active' : 'Starting'}</Text>}
				</Box>
			) : null}
		</>
	);
}

export function submitConsoleMessage(controller: ConsoleController, message: string): void {
	void controller.submit(message).catch(() => {});
}

function MessageLine({ label, text }: { label: 'you' | 'agent'; text: string }) {
	const user = label === 'you';
	return (
		<Box flexDirection="column" marginTop={1}>
			<Text bold color={user ? 'white' : 'black'} backgroundColor={user ? 'blue' : 'cyan'}> {label} </Text>
			<Text>{text}</Text>
		</Box>
	);
}

function QueuedPrompts({ prompts }: { prompts: readonly ConsoleQueuedPrompt[] }) {
	return (
		<Box flexDirection="column" marginTop={1}>
			<Text dimColor backgroundColor="blue"> queue </Text>
			{prompts.map((prompt) => <Text key={prompt.id} dimColor>{prompt.message}</Text>)}
		</Box>
	);
}

function TranscriptLine({ record }: { record: TranscriptRecord }) {
	if (record.tone === 'user' || record.tone === 'normal') {
		return <MessageLine label={record.tone === 'user' ? 'you' : 'agent'} text={record.text} />;
	}
	if (record.layout === 'thinking') {
		return <Box marginY={1}><Text dimColor>{record.text}</Text></Box>;
	}
	return <Text dimColor={record.tone === 'dim'} color={record.tone === 'error' ? 'red' : record.tone === 'success' ? 'green' : record.tone === 'accent' ? 'blue' : undefined}>{record.text}</Text>;
}

export function openConsoleUi(controller: ConsoleController): { waitUntilExit(): Promise<void>; close(): void } {
	const instance = render(<ConsoleUi controller={controller} />, {
		stdin: process.stdin,
		stdout: process.stderr,
		stderr: process.stderr,
		alternateScreen: false,
		exitOnCtrlC: false,
		patchConsole: true,
	});
	return { waitUntilExit: async () => { await instance.waitUntilExit(); }, close: () => instance.unmount() };
}
