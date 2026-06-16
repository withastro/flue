# Testing Conventions

Use this when adding or reviewing tests in this repository.

## Test Location

- Use `<package>/test/` for the active suite.
- Do not add tests to `<package>/test-legacy/`.
- Do not treat archived tests as source of truth when designing active coverage.

## Coverage Judgment

Add tests when they protect a durable contract or meaningful failure mode. Do not add a regression test for every change. Skip tests for incidental implementation details, rare edge cases, or behavior that remains naturally protected by surrounding design.

Prefer the highest practical public interface:

- user-facing behavior for public APIs;
- explicit consumer-facing behavior for stable internal subsystem boundaries.

Avoid directly testing private helpers when the behavior is already exercised through a meaningful interface.

## Test Shape

- Use `describe('someFunction()')` or `describe('SomeManager')`.
- Test names use `it('X when Y')`.
- Prefer explicit, self-contained `it()` blocks.
- Copy-paste in tests is acceptable when it keeps behavior readable.
- Avoid `it.each()` unless cases are genuinely linear and clearer as a table.
- Avoid complex helpers that hide behavior-relevant inputs or expectations.

## Mocks

- Avoid broad mocks of whole files, packages, or modules.
- Prefer real lightweight boundaries, small explicit fakes for injected interfaces, or narrow transport fixtures.
- If broad mocking is unavoidable, document it as temporary and note the design smell.

## Validation Commands

- Runtime type changes: run `pnpm run check:types` in `packages/runtime/`.
- Build runtime before CLI or examples when changes cross package boundaries.
- Use package-local build, typecheck, and test scripts when the change is scoped.

