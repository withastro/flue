const BLUE = '\x1b[34m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function useColor(): boolean {
	return Boolean(process.stderr.isTTY) && process.env.NO_COLOR === undefined;
}

function paint(code: string, text: string): string {
	return useColor() ? `${code}${text}${RESET}` : text;
}

export function blue(text: string): string {
	return paint(BLUE, text);
}

function bold(text: string): string {
	return paint(BOLD, text);
}

export function dim(text: string): string {
	return paint(DIM, text);
}

export function red(text: string): string {
	return paint(RED, text);
}

export function brand(lines: [string, string, string]): string {
	const mark = [blue(' ▗ '), blue(' ▚ '), blue(' ▘ ')];
	return lines.map((line, index) => `${mark[index]} ${line}`).join('\n');
}

export function brandRows(title: string, rows: readonly [string, string | undefined][]): void {
	const visible = rows.filter(
		(row): row is [string, string] => row[1] !== undefined && row[1] !== '',
	);
	const mark = [blue(' ▗ '), blue(' ▚ '), blue(' ▘ ')];
	console.error(`${mark[0]} ${bold(title)}`);
	visible.forEach(([label, value], index) => {
		const prefix = mark[index + 1] ?? '   ';
		console.error(`${prefix} ${dim(label.padEnd(10))}${value}`);
	});
}

export function row(label: string, value: string | undefined): void {
	if (!value) return;
	console.error(`    ${dim(label.padEnd(10))}${value}`);
}

export function section(title: string, values: readonly string[]): void {
	if (values.length === 0) return;
	console.error('');
	console.error(`    ${bold(title)}`);
	for (const value of values) console.error(`      ${value}`);
}

export function note(message: string): void {
	console.error(`    ${dim(message)}`);
}

export function error(message: string): void {
	console.error(`${bold('Error')}: ${message}`);
}

export function success(message: string): void {
	console.error(`${blue('done')} ${message}`);
}
