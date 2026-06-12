export interface Channel<TContext = unknown> {
	/** Verified provider ingress. Mount this anywhere a Fetch handler fits. */
	fetch(request: Request, context?: TContext): Promise<Response>;
	/** Reserved for future long-lived transports on runtimes that support them. */
	start?(ctx?: unknown): Promise<void>;
	/** Reserved for future long-lived transports on runtimes that support them. */
	stop?(): Promise<void>;
}

export type MaybePromise<T> = T | Promise<T>;
export type LazyValue<T, TContext = void> =
	| T
	| undefined
	| ((ctx: TContext) => MaybePromise<T | undefined>);

export interface VerificationResult {
	readonly ok: boolean;
	readonly reason?: string;
}

const textEncoder = new TextEncoder();

export async function resolveLazyValue<T, TContext>(
	value: LazyValue<T, TContext>,
	ctx: TContext,
	label: string,
): Promise<T> {
	const resolved = typeof value === 'function'
		? await (value as (ctx: TContext) => MaybePromise<T | undefined>)(ctx)
		: value;
	if (resolved === undefined || resolved === null || resolved === '') {
		throw new Error(`[flue:channels] Missing ${label}.`);
	}
	return resolved;
}

export function timingSafeEqual(a: string, b: string): boolean {
	const left = textEncoder.encode(a);
	const right = textEncoder.encode(b);
	let diff = left.length ^ right.length;
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
	}
	return diff === 0;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		textEncoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(message));
	return bytesToHex(new Uint8Array(signature));
}

export async function verifyHmacSha256Signature(options: {
	readonly secret: string;
	readonly message: string;
	readonly signature: string | null | undefined;
	readonly prefix?: string;
}): Promise<VerificationResult> {
	if (!options.signature) return { ok: false, reason: 'missing_signature' };
	const expected = `${options.prefix ?? ''}${await hmacSha256Hex(options.secret, options.message)}`;
	return timingSafeEqual(expected, options.signature)
		? { ok: true }
		: { ok: false, reason: 'invalid_signature' };
}

export function bytesToHex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
