# Symbol Import Shape Sub-Agents Handoff

## Task

Improve `entryStrategy: "symbols"` dependency resolution by preserving TypeScript import shapes that the current AST slicer misses:

- default imports: `import Foo from "./foo"`
- namespace imports: `import * as Types from "./types"`
- named aliases: `import { User as DomainUser } from "./user"`
- qualified type names: `Types.User` and nested `Types.Inner.User`
- mixed imports and type-only imports

## Done When

- E2E tests cover the import-shape cases above and fail on the old implementation.
- `symbols` output preserves valid import syntax for retained imports.
- Local dependency files referenced through retained default / namespace / alias imports are copied.
- Existing `graph` behavior is not changed.
- Package tests and build pass.
- Public docs describe the practical AST-slice behavior and supported import shapes.

## Context

- Repository: `/Users/danny/projects/hexai/master`
- Package: `/Users/danny/projects/hexai/master/packages/plugin-contracts-generator`
- Prior analysis: `/Users/danny/projects/hexai/master/packages/plugin-contracts-generator/docs/2026-05-28-symbol-dependency-resolution-options.md`
- Primary implementation file: `/Users/danny/projects/hexai/master/packages/plugin-contracts-generator/src/file-copier.ts`
- Primary E2E file: `/Users/danny/projects/hexai/master/packages/plugin-contracts-generator/e2e/generation/dependency-extraction.test.ts`
- Existing fixture: `/Users/danny/projects/hexai/master/packages/plugin-contracts-generator/e2e/fixtures/dependency-extraction/src`
- Official docs are English.
- Do not touch unrelated `packages/postgres/**` or `.codex/**` changes.

## Harness Design

### Agent A: Test Drift Analyst

- Persona: testing-focused TypeScript tooling engineer.
- Purpose: identify exact E2E/unit test additions needed for default, namespace, alias, mixed, qualified, and type-only import shapes.
- Output: concise report with fixture file names, assertions, and likely old-failure modes.

### Agent B: Implementation Worker

- Persona: careful refactoring engineer.
- Purpose: update `file-copier.ts` import collection/filtering/emission and identifier collection.
- Ownership: `/Users/danny/projects/hexai/master/packages/plugin-contracts-generator/src/file-copier.ts` only.
- Output: changed paths, implementation summary, commands run.

### Agent C: Reviewer / Refactorer

- Persona: strict code reviewer focused on regressions, compiler API correctness, and maintainability.
- Purpose: review implementation and tests after Agent B, identify blockers, suggest small refactors.
- Output: findings first, with file/line references.

### Agent D: Docs Drift Agent

- Persona: concise English technical writer.
- Purpose: update README/domain/architecture docs to reflect supported `symbols` import-shape behavior.
- Ownership: docs and README only.
- Output: changed paths and summary.

## Pipeline

1. Phase 1: Agent A designs test coverage while Agent B starts implementation against known requirements.
2. Phase 2: Main integrates/adjusts tests if needed, runs focused tests.
3. Phase 3: Agent C reviews the resulting code/tests.
4. Phase 4: Agent D updates docs after behavior stabilizes.
5. Phase 5: Main runs package validation and records results.

## Progress

- [x] Handoff created
- [x] Agent A dispatched
- [x] Agent B dispatched
- [x] Tests added
- [x] Implementation completed
- [x] Review completed
- [x] Docs updated
- [x] Validation completed

## Results

### Agent A: Test Drift Analyst

Recommendation: add E2E coverage in `e2e/generation/dependency-extraction.test.ts` and extend the existing `dependency-extraction` fixture. Unit tests are optional unless a pure helper is extracted.

Required cases:

- default import and copied dependency file
- namespace import and nested qualified type names
- named import alias preservation
- mixed default + named alias import with unused named import removed
- type-only default import preservation
- generated output compilation

### Phase 2 Validation

Focused command passed after fixture export-name cleanup:

```bash
pnpm --filter @hexaijs/plugin-contracts-generator exec vitest run e2e/generation/dependency-extraction.test.ts src/file-copier.test.ts
```

Result: 2 files passed, 29 tests passed.

### Agent C: Review / Refactor

Finding: symbols-mode local dependencies can include top-level `FunctionDeclaration`s. Already exported helper functions were not recognized by `nodeHasExportKeyword()`, creating a possible `export export function` output.

Resolution:

- Added an E2E regression case with an exported local helper function used by the selected class body.
- Updated `nodeHasExportKeyword()` to include `FunctionDeclaration`.

### Phase 3 Validation

Focused command passed after review fix:

```bash
pnpm --filter @hexaijs/plugin-contracts-generator exec vitest run e2e/generation/dependency-extraction.test.ts src/file-copier.test.ts
```

Result: 2 files passed, 30 tests passed.

### Agent D: Docs Drift

Updated public and internal package docs to describe the stabilized `symbols` behavior:

- README now lists retained import shapes for selected entry files and states that dependency files are copied whole.
- Architecture docs now describe direct AST expansion, import-shape preservation, and file-granularity dependency copying.
- Domain model docs now clarify that `symbols` relies on entry-file AST filtering rather than TypeChecker semantic slicing.

Wording caveat: the docs intentionally describe practical AST support, not a guarantee of complete TypeScript semantic slicing.

### Final Validation

Commands:

```bash
pnpm --filter @hexaijs/plugin-contracts-generator test
pnpm --filter @hexaijs/plugin-contracts-generator build
pnpm --filter @hexaijs/contracts test
pnpm --filter @hexaijs/contracts build
git diff --check -- packages/plugin-contracts-generator packages/contracts
```

Results:

- Generator tests passed: 30 files, 407 tests.
- Generator build passed.
- Contracts tests passed: 3 files, 4 tests.
- Contracts build passed.
- Diff whitespace check passed.
