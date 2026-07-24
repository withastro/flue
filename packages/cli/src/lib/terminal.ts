import pc from 'picocolors';

export function brand(lines: [string, string, string]): string {
	const mark = [pc.blue(' ▗ '), pc.blue(' ▚ '), pc.blue(' ▘ ')];
	return lines.map((line, index) => `${mark[index]} ${line}`).join('\n');
}

export function brandRows(title: string, rows: readonly [string, string | undefined][]): void {
	const visible = rows.filter(
		(row): row is [string, string] => row[1] !== undefined && row[1] !== '',
	);
	const mark = [pc.blue(' ▗ '), pc.blue(' ▚ '), pc.blue(' ▘ ')];
	console.error(`${mark[0]} ${pc.bold(title)}`);
	visible.forEach(([label, value], index) => {
		const prefix = mark[index + 1] ?? '   ';
		console.error(`${prefix} ${pc.dim(label.padEnd(10))}${value}`);
	});
}

export function row(label: string, value: string | undefined): void {
	if (!value) return;
	console.error(`    ${pc.dim(label.padEnd(10))}${value}`);
}

export function note(message: string): void {
	console.error(`    ${pc.dim(message)}`);
}

export function error(message: string): void {
	console.error(`${pc.bold('Error')}: ${message}`);
}

export function success(message: string): void {
	console.error(`${pc.blue('done')} ${message}`);
}
