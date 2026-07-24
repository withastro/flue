/**
 * FNV-1a 64-bit over a string's UTF-16 code units, as a fixed-width hex
 * digest. Change detection and content-identity checks, not cryptography.
 */
export function fnv1a64(text: string): string {
	let hash = 0xcbf29ce484222325n;
	for (let index = 0; index < text.length; index++) {
		hash ^= BigInt(text.charCodeAt(index));
		hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return hash.toString(16).padStart(16, '0');
}
