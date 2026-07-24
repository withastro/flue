import { encodeBase64 } from './base64.ts';
import type { PackagedSkillDirectory, PackagedSkillFile, SkillReference } from './types.ts';

export interface SkillPackageInput {
	name: string;
	description: string;
	files: ReadonlyArray<{ path: string; content: Uint8Array }>;
}

const directoryKey = Symbol.for('@flue/runtime/packaged-skill/v1');
const encoder = new TextEncoder();

export function buildPackagedSkill(input: SkillPackageInput): PackagedSkillDirectory {
	const entries = [...input.files].sort((left, right) =>
		left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
	);
	const hashInput: Uint8Array[] = [];
	const files: Record<string, PackagedSkillFile> = Object.create(null);
	for (const entry of entries) {
		const pathBytes = encoder.encode(entry.path);
		const content = new Uint8Array(entry.content);
		const lengths = new Uint8Array(8);
		const view = new DataView(lengths.buffer);
		view.setUint32(0, pathBytes.byteLength);
		view.setUint32(4, content.byteLength);
		hashInput.push(lengths, pathBytes, content);
		files[entry.path] = Object.freeze({
			encoding: 'base64',
			kind: isTextContent(content) ? 'text' : 'binary',
			content: encodeBase64(content),
		});
	}
	return Object.freeze({
		id: `skill:${input.name}:${sha256Hex(concatBytes(hashInput)).slice(0, 16)}`,
		name: input.name,
		description: input.description,
		files: Object.freeze(files),
	});
}

export function createSkillReference(directory: PackagedSkillDirectory): SkillReference {
	const reference: SkillReference = {
		__flueSkillReference: true,
		id: directory.id,
		name: directory.name,
		description: directory.description,
	};
	Object.defineProperty(reference, directoryKey, { value: directory });
	return Object.freeze(reference);
}

export function getSkillReferenceDirectory(
	reference: SkillReference,
): PackagedSkillDirectory | undefined {
	return (reference as SkillReference & { [directoryKey]?: PackagedSkillDirectory })[directoryKey];
}

function isTextContent(content: Uint8Array): boolean {
	if (content.includes(0)) return false;
	try {
		new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(content);
		return true;
	} catch {
		return false;
	}
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	const result = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}
	return result;
}

function sha256Hex(input: Uint8Array): string {
	const constants = new Uint32Array([
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
		0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
		0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
		0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
		0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
		0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
	]);
	const length = input.byteLength;
	const paddedLength = Math.ceil((length + 9) / 64) * 64;
	const padded = new Uint8Array(paddedLength);
	padded.set(input);
	padded[length] = 0x80;
	const view = new DataView(padded.buffer);
	const bitLength = BigInt(length) * 8n;
	view.setUint32(paddedLength - 8, Number(bitLength >> 32n));
	view.setUint32(paddedLength - 4, Number(bitLength & 0xffffffffn));
	const state = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	]);
	const words = new Uint32Array(64);
	const word = (index: number) => words[index] ?? 0;
	const constant = (index: number) => constants[index] ?? 0;
	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
		for (let index = 16; index < 64; index++) {
			const a = word(index - 15);
			const b = word(index - 2);
			const s0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
			const s1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
			words[index] = (word(index - 16) + s0 + word(index - 7) + s1) >>> 0;
		}
		let a = state[0] ?? 0;
		let b = state[1] ?? 0;
		let c = state[2] ?? 0;
		let d = state[3] ?? 0;
		let e = state[4] ?? 0;
		let f = state[5] ?? 0;
		let g = state[6] ?? 0;
		let h = state[7] ?? 0;
		for (let index = 0; index < 64; index++) {
			const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
			const choice = (e & f) ^ (~e & g);
			const temporary1 = (h + sum1 + choice + constant(index) + word(index)) >>> 0;
			const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
			const majority = (a & b) ^ (a & c) ^ (b & c);
			const temporary2 = (sum0 + majority) >>> 0;
			h = g;
			g = f;
			f = e;
			e = (d + temporary1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temporary1 + temporary2) >>> 0;
		}
		state[0] = (wordFrom(state, 0) + a) >>> 0;
		state[1] = (wordFrom(state, 1) + b) >>> 0;
		state[2] = (wordFrom(state, 2) + c) >>> 0;
		state[3] = (wordFrom(state, 3) + d) >>> 0;
		state[4] = (wordFrom(state, 4) + e) >>> 0;
		state[5] = (wordFrom(state, 5) + f) >>> 0;
		state[6] = (wordFrom(state, 6) + g) >>> 0;
		state[7] = (wordFrom(state, 7) + h) >>> 0;
	}
	return [...state].map((word) => word.toString(16).padStart(8, '0')).join('');
}

function wordFrom(words: Uint32Array, index: number): number {
	return words[index] ?? 0;
}

function rotateRight(value: number, amount: number): number {
	return (value >>> amount) | (value << (32 - amount));
}
