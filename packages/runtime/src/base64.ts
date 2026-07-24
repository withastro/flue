/**
 * Byte <-> base64 conversion on the platform `btoa`/`atob` primitives —
 * runtime-agnostic (Node, Workers) and protocol-independent, so every
 * module shares one copy. URL-safe id encoding stays where it lives
 * (conversation-records.ts): it is a different output alphabet, not a
 * different implementation of this.
 */

/** Chunked so large payloads never overflow the argument-spread limit. */
export function encodeBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

export function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
