# PublicContract Entry Strategy Sub-Agents Handoff

> Current default note: this handoff started during an earlier graph-default design phase. The implemented product decision is that `entryStrategy: "symbols"` is the default, while `graph` remains an explicit opt-in compatibility strategy.

## Task

`PublicContract` should behave like `PublicCommand`, `PublicQuery`, and `PublicEvent` in the entry strategy pipeline: the default `symbols` strategy extracts selected public declarations and their required dependencies, while the explicit `graph` strategy copies selected entry files and their dependency graph.

## Done When

- PublicContract supports class decorator syntax: `@PublicContract()`.
- PublicContract comments support line, block, and JSDoc forms:
  - `// @PublicContract()`
  - `/* @PublicContract() */`
  - `/** @PublicContract() */`
- Entry expansion is controlled by an explicit `entryStrategy`:
  - `symbols` default: extract selected declarations and minimal dependencies.
  - `graph`: copy selected entry files and dependency graph.
- Message filters select graph roots and registry entries only under `graph`; they do not silently switch strategy.
- Graph strategy logs a warning when message filters are used, because whole entry files can include additional declarations.
- MessageRegistry continues to register selected messages only.
- Tests, docs, and package exports are updated.
- Local package build and tests pass.

## Constraints

- Communicate with the user in Korean.
- Official docs in this package are written in English.
- Do not touch unrelated current workspace changes:
  - `/Users/danny/projects/hexai/master/packages/postgres/**`
  - `/Users/danny/projects/hexai/master/.codex/**`
- Do not publish or commit unless explicitly requested later.
- Prefer existing package patterns; keep the implementation small.

## Initial Harness

### Agent A: Architecture Analyst

- Persona: compiler/pipeline architect, biased toward clean phase separation.
- Purpose: map current scanner/parser/pipeline/copier/CLI behavior and propose the minimal architecture change.
- Output: facts, recommended types/options, file-level change plan, risks.

### Agent B: Test Designer

- Persona: test-first engineer, biased toward observable behavior.
- Purpose: add or specify failing tests for decorator support, block comments, graph vs symbols strategy, and filter warnings.
- Output: test patch or exact test cases.

### Agent C: Implementer

- Persona: conservative TypeScript maintainer.
- Purpose: implement the selected architecture after Agent A/B results.
- Output: code patch summary, files changed, validation run.

### Agent D: Reviewer

- Persona: skeptical reviewer focused on regressions and API drift.
- Purpose: review implementation for hidden behavior changes, especially existing message runtime copying.
- Output: findings with file/line references.

### Agent E: QA/Docs

- Persona: release-minded QA and docs owner.
- Purpose: run package validation, update English docs, and report residual risks.
- Output: commands/results, docs changed, remaining risk.

## Phase Progress

- Phase 1: Harness created.
- Phase 1: Agent A (Architecture Analyst) dispatched.
- Phase 1: Agent B (Test Designer) dispatched.
- Phase 1: Agent A completed architecture proposal: `entryStrategy` belongs after selection; the initial graph-default proposal was superseded by the later symbols-default decision.
- Phase 1: Agent B completed failing tests for `PublicContract` decorator, block comments, entry strategies, CLI option, registry behavior.
- Phase 2: Agent C implemented `PublicContract` decorator support, `entryStrategy`, symbols extraction, CLI/plugin/config/API wiring.
- Phase 2: Agent C focused validation passed for contracts decorator tests, generator focused tests, and both package builds.
- Phase 3: Agent D review found merge-blocking issues: decorator removal misses `PublicContract` / `@hexaijs/contracts/decorators`, symbols-mode class body stripping can emit invalid strict TypeScript, entryStrategy config lacks runtime validation.
- Phase 3: Agent E updated English docs and ran full package QA successfully, but reviewer findings require a fix loop.
- Phase 4: Agent F fixed reviewer findings: decorator removal/import cleanup, valid symbols-mode class output, `entryStrategy` runtime validation, and tests.
- Phase 4: Agent F validation passed for `@hexaijs/contracts` test/build, `@hexaijs/plugin-contracts-generator` test/build, and diff check.
- Phase 3: Agent E ran full package QA. Initial generator suite exposed one stale dependency-extraction test that assumed message filters imply symbol extraction; the test now opts into `entryStrategy: "symbols"`.
- Phase 3: Agent E updated English docs for `PublicContract` class decorator support, line/block/JSDoc comment markers, entry strategies, graph filter behavior, and message-only registry generation.
- Phase 5: Documentation Drift Agent reconciled public docs with the implemented graph/symbols entry strategy, selected-message registry behavior, warning semantics, and Scan -> Parse -> Selection -> EntryStrategy -> Emit boundaries.
- Phase 5: Local package gate passed: `pnpm --filter @hexaijs/contracts test`, `pnpm --filter @hexaijs/contracts build`, `pnpm --filter @hexaijs/plugin-contracts-generator test`, `pnpm --filter @hexaijs/plugin-contracts-generator build`, and `git diff --check -- packages/contracts packages/plugin-contracts-generator`.
- Phase 6: Real-project QA Agent created a new worktree at `/Users/danny/projects/hzpro-dev-contracts-generator-regression-20260528-172936` from `/Users/danny/projects/hzpro-dev/main` HEAD `d231213326c5b5f4419011670a943866dd1db869`.
- Phase 6: Real-project baseline passed `pnpm install --frozen-lockfile`, `pnpm build common`, and `pnpm generate-contracts`; `pnpm test` failed before and after due to missing `packages/contexts/interview/.env`, so it is classified as a baseline environment issue.
- Phase 6: Real-project local tarball QA passed `pnpm build common` and `pnpm generate-contracts` with local `@hexaijs/contracts` and `@hexaijs/plugin-contracts-generator` tarballs.
- Phase 6: Real-project generated drift was expected under the new graph semantics: request registry includes selected commands and queries, and graph strategy copies additional dependency files. Build passed after generation.
- Phase 7: Final review found a remaining symbols-mode blocker: `PublicContract` class bodies could reference value-position dependencies such as `DEFAULT_STATUS`, `Status.Active`, or `Factory.create()` without including those dependencies.
- Phase 7: Fix loop expanded symbols-mode identifier collection for class body value references, restricted local dependency discovery to top-level declarations, added `@hexaijs/contracts` root import cleanup, and covered single-line JSDoc marker removal.
- Phase 7: Final validation passed: focused public-contract/file-copier tests, full generator test suite, generator build, contracts test/build, and diff whitespace check.
- Phase 7: A second local real-project smoke worktree at `/Users/danny/projects/hzpro-dev/worktrees/contracts-generator-regression-20260528-173401` passed latest tarball `pnpm install`, `pnpm -F @hakzzong/common build`, and `pnpm generate-contracts`.
- Phase 8: Public default was corrected to `symbols`; `graph` remains explicit opt-in.
- Phase 8: Response contract symbols are now included in default `symbols` output when discovered by explicit decorator response options or response naming conventions.
- Phase 8: Real-project QA used a fresh worktree at `/Users/danny/projects/hzpro-dev/worktrees/contracts-generator-symbols-default-20260528-2147`. Baseline `0.2.4` passed after `pnpm -F @hakzzong/common build`; local `0.3.0` tarballs passed `pnpm generate-contracts`, including contracts build. Generated drift had no file additions/deletions and no root registry index diff; observed changes were decorator import cleanup / printer normalization in generated files.

## Results

- Implemented `entryStrategy: "graph" | "symbols"` with public default `symbols`.
- `PublicContract` class decorator support is available through `@hexaijs/contracts/decorators`.
- PublicContract comment markers support line, block, and JSDoc comments.
- `graph` copies selected entry files and their dependency graph; message filters select roots and registry entries only.
- `symbols` is the default strict declaration extraction strategy.
- Message registry generation remains message-only and selected-message-only.
- English docs were updated for README, architecture, domain model, contracts package usage, and CLI/config/programmatic/plugin examples.
- Package-level tests/builds pass.
- Real-project regression QA in `hzpro-dev` passed generation/build comparison; the only full test failure is a pre-existing missing `.env` baseline issue.
- The final symbols-mode blocker is fixed and covered by compile-safety tests.
- The public default is `symbols`; `graph` is available only when explicitly requested.
- Same-file response contracts are preserved in default `symbols` output.
