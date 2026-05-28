# Symbol Dependency Resolution Options

## Task

Compare two implementation options for improving `entryStrategy: "symbols"` dependency resolution:

1. Direct AST support for default imports, namespace imports, and named aliases.
2. TypeScript `Program` / `TypeChecker` based semantic dependency resolution using the scanned package's `tsconfig.json`.

Done when one internal sub-agent report and one independent Claude second-opinion report are collected and synthesized into a recommendation.

## Context

- Repository: `/Users/danny/projects/hexai/master`
- Package: `/Users/danny/projects/hexai/master/packages/plugin-contracts-generator`
- Main files:
  - `/Users/danny/projects/hexai/master/packages/plugin-contracts-generator/src/file-copier.ts`
  - `/Users/danny/projects/hexai/master/packages/plugin-contracts-generator/src/context-config.ts`
  - `/Users/danny/projects/hexai/master/packages/plugin-contracts-generator/src/pipeline.ts`
  - `/Users/danny/projects/hexai/master/packages/plugin-contracts-generator/src/index.ts`
- Current implementation already uses the TypeScript compiler API for AST transforms.
- Current `ContextConfig` loads package-level `tsconfig.json`, but only uses it for path alias resolution.
- Current `symbols` mode is a practical AST slice, not a full semantic extraction engine.

## Harness Design

### Agents

1. Internal Sub-Agent: Generator Architecture Analyst
   - Persona: senior TypeScript tooling engineer focused on incremental architecture and regression risk.
   - Purpose: inspect the current codebase and compare direct AST expansion vs TypeChecker-based resolution.
   - Output: concise markdown report with recommendation, implementation shape, tests, and risks.

2. Claude Second Opinion
   - Persona: independent TypeScript compiler API reviewer.
   - Purpose: analyze the same two options without being anchored on the main session's conclusion.
   - Output: concise markdown report with recommendation and caveats.

### Pipeline

Both agents run in parallel. The main session synthesizes their conclusions after both reports are available.

## Progress

- [x] Write harness handoff
- [x] Dispatch internal Sub-Agent
- [x] Dispatch Claude second opinion in background
- [x] Collect reports
- [x] Synthesize final recommendation

## Results

### Internal Sub-Agent

Recommendation: implement direct AST expansion first. The current weak cases are mostly caused by `FileCopier` import-shape handling, not by a fundamental need for a compiler-backed semantic slicer.

Key points:

- Extend `buildImportMap`, `filterImports`, and `appendImportStatements` to preserve default imports, namespace imports, named aliases, and original import shape.
- Extend identifier collection for `TypeReferenceNode` with `QualifiedName` roots such as `Types.User`.
- Add E2E coverage for default import, namespace import, named alias, and compilation.
- Treat TypeChecker as a later architectural step if dependency files also need symbol-level slicing.

### Claude Second Opinion

Recommendation: implement direct AST expansion first. The current weak cases are import/declaration shape coverage gaps inside one entry file, not a strong reason to introduce a package-wide semantic compiler program.

Key points:

- `file-copier.ts` should preserve original import declarations and filter them using used local names.
- `TypeReferenceNode` with `QualifiedName` must collect the leftmost root identifier.
- Import emission should use TypeScript printer on updated import declarations rather than hand-built strings.
- `usedModuleSpecifiers` must be derived from every retained import shape so dependency files are still copied.
- TypeChecker becomes worthwhile when the generator needs dependency-file symbol slicing, re-export semantic tracing, or full compiler-level resolution.

### Final Synthesis

Both reports recommend Option 1 (direct AST expansion) as the next step. Option 2 (TypeScript `Program` / `TypeChecker`) is technically feasible and likely the right long-term base for a semantic slicer, but it is too large for the current bug class.

Recommended implementation sequence:

1. Add failing E2E coverage for default imports, namespace imports, named aliases, mixed imports, qualified names, and type-only default imports.
2. Refactor import handling in `file-copier.ts` around original `ImportDeclaration` nodes.
3. Collect leftmost roots from qualified type names.
4. Emit filtered imports with the TypeScript printer.
5. Keep TypeChecker as a future architecture option if dependency files need symbol-level slicing.
