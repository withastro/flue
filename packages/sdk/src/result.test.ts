import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
	buildPromptText,
	buildResultExtractionPrompt,
	buildResultInstructions,
	buildSkillPrompt,
	extractResult,
	HEADLESS_PREAMBLE,
	ResultExtractionError,
} from './result.ts';

const wrap = (body: string) => `---RESULT_START---\n${body}\n---RESULT_END---`;

describe('extractResult', () => {
	describe('object schemas', () => {
		const schema = v.object({ answer: v.number() });

		it('parses a valid object block', () => {
			const text = `Sure thing.\n${wrap('{"answer": 42}')}\n`;
			expect(extractResult(text, schema)).toEqual({ answer: 42 });
		});

		it('takes the LAST block when multiple are present', () => {
			const text = [
				'First attempt:',
				wrap('{"answer": 1}'),
				'Actually wait, the right answer:',
				wrap('{"answer": 99}'),
			].join('\n');
			expect(extractResult(text, schema)).toEqual({ answer: 99 });
		});

		it('throws ResultExtractionError when delimiters are missing', () => {
			expect(() => extractResult('just some prose, no block', schema)).toThrowError(
				ResultExtractionError,
			);
		});

		it('error.message mentions the missing delimiters', () => {
			try {
				extractResult('nope', schema);
				expect.fail('expected throw');
			} catch (err) {
				expect(err).toBeInstanceOf(ResultExtractionError);
				expect((err as ResultExtractionError).message).toContain('RESULT_START');
				expect((err as ResultExtractionError).rawOutput).toBe('nope');
			}
		});

		it('throws on invalid JSON inside the block', () => {
			const text = wrap('{not json}');
			expect(() => extractResult(text, schema)).toThrowError(/invalid JSON/);
		});

		it('throws on schema mismatch (wrong type)', () => {
			const text = wrap('{"answer": "not a number"}');
			expect(() => extractResult(text, schema)).toThrowError(/does not match/);
		});

		it('rawOutput on schema-mismatch carries the trimmed block, not the full input', () => {
			// Per result.ts:101, ResultExtractionError.rawOutput is the captured
			// block content (trimmed) — useful for debugging tool errors. The
			// surrounding prose should NOT leak into rawOutput.
			const text = `Some preamble.\n${wrap('{"answer": "not a number"}')}\nTrailing prose.`;
			try {
				extractResult(text, schema);
				expect.fail('expected throw');
			} catch (err) {
				expect(err).toBeInstanceOf(ResultExtractionError);
				const raw = (err as ResultExtractionError).rawOutput;
				expect(raw).toBe('{"answer": "not a number"}');
				expect(raw).not.toContain('Some preamble');
				expect(raw).not.toContain('Trailing prose');
			}
		});

		it('throws on schema mismatch (missing field)', () => {
			const text = wrap('{}');
			expect(() => extractResult(text, schema)).toThrowError(ResultExtractionError);
		});

		it('trims surrounding whitespace inside the block', () => {
			const text = `---RESULT_START---\n   \n  {"answer": 7}  \n  \n---RESULT_END---`;
			expect(extractResult(text, schema)).toEqual({ answer: 7 });
		});
	});

	describe('array schemas', () => {
		const schema = v.array(v.string());

		it('parses a valid array block', () => {
			const text = wrap('["a", "b", "c"]');
			expect(extractResult(text, schema)).toEqual(['a', 'b', 'c']);
		});

		it('throws on element-type mismatch', () => {
			const text = wrap('["a", 2, "c"]');
			expect(() => extractResult(text, schema)).toThrowError(ResultExtractionError);
		});
	});

	describe('non-object/array schemas (no JSON.parse)', () => {
		// String/number/boolean schemas skip JSON parsing per result.ts:86 —
		// the raw block content is fed straight to valibot.
		it('accepts a bare string for a string schema', () => {
			const schema = v.string();
			const text = wrap('hello world');
			expect(extractResult(text, schema)).toBe('hello world');
		});

		it('still rejects schema mismatch on raw values', () => {
			// number schema reading "hello" — valibot rejects, ResultExtractionError thrown.
			const schema = v.number();
			const text = wrap('hello');
			expect(() => extractResult(text, schema)).toThrowError(ResultExtractionError);
		});
	});

	describe('multi-line content', () => {
		it('preserves newlines inside the captured block', () => {
			const schema = v.object({ text: v.string() });
			const text = wrap('{"text": "line1\\nline2"}');
			const result = extractResult(text, schema);
			expect(result.text).toBe('line1\nline2');
		});

		it('handles a block that contains the literal substring "RESULT_END" inside JSON', () => {
			// The closing delimiter is matched non-greedily; an earlier match wins
			// even if a later valid block exists. Document the actual behavior.
			const schema = v.object({ note: v.string() });
			const text = [
				'---RESULT_START---',
				'{"note": "before --- some text"}',
				'---RESULT_END---',
				'',
				'---RESULT_START---',
				'{"note": "later block"}',
				'---RESULT_END---',
			].join('\n');
			expect(extractResult(text, schema)).toEqual({ note: 'later block' });
		});

		it('truncates at literal ---RESULT_END--- inside content (regex non-greedy behavior)', () => {
			// Documents real LLM failure mode: if the model emits the closing
			// delimiter literally inside the JSON body, the non-greedy regex
			// truncates the capture at that point and downstream JSON parsing
			// fails. The failure mode is a clean ResultExtractionError flagging
			// the JSON parse failure — not a silent wrong-result.
			const schema = v.object({ text: v.string() });
			const text = [
				'---RESULT_START---',
				'{"text": "see ---RESULT_END--- in code"}',
				'---RESULT_END---',
			].join('\n');
			expect(() => extractResult(text, schema)).toThrowError(/invalid JSON/);
		});

		it('throws ResultExtractionError on a half-open block (RESULT_START without RESULT_END)', () => {
			// Real LLM failure mode: emission cuts off mid-result. Should fail
			// with the "no block found" error path, not match anything weird.
			const schema = v.object({ x: v.number() });
			const text = '---RESULT_START---\n{"x": 1}\n(end of stream, no closing delimiter)';
			expect(() => extractResult(text, schema)).toThrowError(/RESULT_START/);
		});
	});
});

describe('buildResultInstructions', () => {
	it('includes a JSON Schema rendering of the valibot schema', () => {
		const schema = v.object({ answer: v.number() });
		const out = buildResultInstructions(schema);
		expect(out).toContain('"type": "object"');
		expect(out).toContain('"answer"');
		// JSON Schema $schema metadata is stripped (see result.ts:9).
		expect(out).not.toContain('$schema');
	});

	it('shows both the object and string examples', () => {
		const out = buildResultInstructions(v.object({ k: v.string() }));
		expect(out).toContain('Example: (Object)');
		expect(out).toContain('Example: (String)');
		expect(out).toContain('---RESULT_START---');
		expect(out).toContain('---RESULT_END---');
	});

	it('renders nested arrays of objects', () => {
		const schema = v.array(v.object({ id: v.number(), name: v.string() }));
		const out = buildResultInstructions(schema);
		expect(out).toContain('"type": "array"');
		expect(out).toContain('"items"');
		expect(out).toContain('"id"');
		expect(out).toContain('"name"');
	});

	it('marks required fields and excludes optional ones from the required list', () => {
		const schema = v.object({
			must: v.string(),
			maybe: v.optional(v.number()),
		});
		const out = buildResultInstructions(schema);
		// "must" is required; "maybe" is optional. JSON Schema's `required`
		// array should include the former and not the latter.
		const requiredMatch = out.match(/"required":\s*\[([^\]]*)\]/);
		expect(requiredMatch).not.toBeNull();
		const requiredList = requiredMatch?.[1] ?? '';
		expect(requiredList).toContain('"must"');
		expect(requiredList).not.toContain('"maybe"');
	});

	it('renders picklist as an enum', () => {
		const schema = v.picklist(['low', 'medium', 'high']);
		const out = buildResultInstructions(schema);
		expect(out).toContain('"enum"');
		expect(out).toContain('"low"');
		expect(out).toContain('"medium"');
		expect(out).toContain('"high"');
	});
});

describe('buildResultExtractionPrompt', () => {
	it('starts with the "Your task is complete" follow-up instruction', () => {
		const out = buildResultExtractionPrompt(v.object({ x: v.number() }));
		expect(out.startsWith('Your task is complete.')).toBe(true);
	});

	it('embeds the schema instructions', () => {
		const out = buildResultExtractionPrompt(v.object({ x: v.number() }));
		expect(out).toContain('---RESULT_START---');
	});
});

describe('buildPromptText', () => {
	it('prepends the headless preamble', () => {
		const out = buildPromptText('do the thing');
		expect(out.startsWith(HEADLESS_PREAMBLE)).toBe(true);
		expect(out).toContain('do the thing');
	});

	it('omits result instructions when no schema given', () => {
		const out = buildPromptText('hello');
		expect(out).not.toContain('---RESULT_START---');
	});

	it('appends result instructions when schema given', () => {
		const out = buildPromptText('hello', v.object({ k: v.string() }));
		expect(out).toContain('---RESULT_START---');
		expect(out).toContain('you MUST output your result');
	});

	it('emits the headless preamble exactly once', () => {
		const out = buildPromptText('hello', v.object({ k: v.string() }));
		const occurrences = out.split(HEADLESS_PREAMBLE).length - 1;
		expect(occurrences).toBe(1);
	});
});

describe('buildSkillPrompt', () => {
	const skillBody = '# Skill\nDo X then Y.';

	it('prepends headless preamble + skill instructions', () => {
		const out = buildSkillPrompt(skillBody);
		expect(out.startsWith(HEADLESS_PREAMBLE)).toBe(true);
		expect(out).toContain(skillBody);
	});

	it('serializes args block as JSON when args present', () => {
		const out = buildSkillPrompt(skillBody, { issueNumber: 42, name: 'Alice' });
		expect(out).toContain('Arguments:');
		expect(out).toContain('"issueNumber": 42');
		expect(out).toContain('"name": "Alice"');
	});

	it('omits args block when args is undefined', () => {
		const out = buildSkillPrompt(skillBody);
		expect(out).not.toContain('Arguments:');
	});

	it('omits args block when args is an empty object', () => {
		const out = buildSkillPrompt(skillBody, {});
		expect(out).not.toContain('Arguments:');
	});

	it('appends result delimiters when schema is given', () => {
		const out = buildSkillPrompt(skillBody, undefined, v.object({ k: v.string() }));
		expect(out).toContain('---RESULT_START---');
	});

	it('emits the headless preamble exactly once', () => {
		const out = buildSkillPrompt(skillBody, { a: 1 }, v.object({ k: v.string() }));
		const occurrences = out.split(HEADLESS_PREAMBLE).length - 1;
		expect(occurrences).toBe(1);
	});

	it('orders sections: preamble → instructions → args → result delimiters', () => {
		const out = buildSkillPrompt(
			skillBody,
			{ issueNumber: 42 },
			v.object({ k: v.string() }),
		);
		const preambleAt = out.indexOf(HEADLESS_PREAMBLE);
		const skillAt = out.indexOf(skillBody);
		const argsAt = out.indexOf('Arguments:');
		const resultAt = out.indexOf('---RESULT_START---');
		expect(preambleAt).toBeGreaterThanOrEqual(0);
		expect(skillAt).toBeGreaterThan(preambleAt);
		expect(argsAt).toBeGreaterThan(skillAt);
		expect(resultAt).toBeGreaterThan(argsAt);
	});
});

describe('ResultExtractionError', () => {
	it('captures rawOutput separately from message', () => {
		const err = new ResultExtractionError('boom', 'the raw text');
		expect(err.message).toBe('boom');
		expect(err.rawOutput).toBe('the raw text');
		expect(err.name).toBe('ResultExtractionError');
		expect(err).toBeInstanceOf(Error);
	});
});
