export type FetchLike = typeof fetch;

export function requireEnvToken(name: string, help: string): string {
	const token = process.env[name];
	if (!token) throw new Error(`${name} is required. ${help}`);
	return token;
}

export async function readJsonResponse(response: Response, serviceName: string): Promise<any> {
	const text = await response.text();
	let data: any;
	try {
		data = text ? JSON.parse(text) : {};
	} catch {
		throw new Error(`${serviceName} returned non-JSON response: ${text.slice(0, 500)}`);
	}
	if (!response.ok) {
		throw new Error(`${serviceName} HTTP ${response.status}: ${JSON.stringify(data).slice(0, 1000)}`);
	}
	return data;
}

export function json(value: unknown): string {
	return JSON.stringify(value, null, 2);
}
