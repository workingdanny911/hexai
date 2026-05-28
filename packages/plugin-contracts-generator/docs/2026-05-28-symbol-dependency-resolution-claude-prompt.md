You are an independent TypeScript compiler API reviewer.

Goal:
Compare two implementation options for improving dependency resolution in `entryStrategy: "symbols"` for this repository:

1. Direct AST expansion: extend the existing AST/import-map logic to support default imports, namespace imports, named aliases, and qualified names.
2. TypeScript semantic resolution: build a `ts.Program` from the scanned package's `tsconfig.json` and use `TypeChecker` / symbols to resolve dependencies.

Repository context:
- Repository root: `/Users/danny/projects/hexai/master`
- Package: `/Users/danny/projects/hexai/master/packages/plugin-contracts-generator`
- Relevant files:
  - `/Users/danny/projects/hexai/master/packages/plugin-contracts-generator/src/file-copier.ts`
  - `/Users/danny/projects/hexai/master/packages/plugin-contracts-generator/src/context-config.ts`
  - `/Users/danny/projects/hexai/master/packages/plugin-contracts-generator/src/pipeline.ts`
  - `/Users/danny/projects/hexai/master/packages/plugin-contracts-generator/src/index.ts`
  - `/Users/danny/projects/hexai/master/packages/plugin-contracts-generator/e2e/generation`

Known current behavior to verify from code:
- The generator already uses TypeScript compiler API AST traversal and printing.
- `ContextConfig` already loads context/package `tsconfig.json`, but currently uses it mainly for path alias resolution.
- The current symbols extraction is not a full semantic compiler-backed extraction engine.
- Weak cases under discussion:
  - `import Foo from "./foo"; type A = Foo`
  - `import * as Types from "./types"; type A = Types.User`
  - `import { User as DomainUser } from "./user"; type A = DomainUser`

Evaluation criteria:
- Correctness for TypeScript dependency tracing
- Implementation effort
- Performance and caching impact
- Regression risk in the current generator
- Fit with the current architecture
- Testing strategy

Important:
- Do not edit files.
- Inspect the code directly.
- Do not assume conversation history.
- Be honest about uncertainty.

Output in Korean markdown only:

## Recommendation

One concise paragraph.

## Comparison

A table comparing both options.

## Implementation Sketch

Concrete files/classes/functions to change for the recommended option.

## Tests

Specific tests to add.

## Risks

Hidden gotchas or failure modes.
