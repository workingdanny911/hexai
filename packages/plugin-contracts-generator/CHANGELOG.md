# Changelog

## [0.5.1] - 2026-06-19

### Added

- Added `outputModuleSpecifiers: "js" | "extensionless"` and the `--output-module-specifiers` CLI/plugin option for choosing generated relative import/export module specifiers globally, per configured output, or per run.

### Changed

- Generated relative import/export specifiers now default to `.js` for NodeNext and ESM-compatible output.
- Root registry namespace imports and exports now use `./context/index.js` by default instead of directory imports.
- Copied local relative import/export declarations are normalized to `.js` by default when they target copied local files.
- Legacy extensionless generated output remains available with `outputModuleSpecifiers: "extensionless"`.

### Fixed

- Resolved NodeNext-style source imports such as `./shared.js` back to TypeScript source files such as `shared.ts`, including pure type dependency files.

## [0.5.0] - 2026-06-01

### Added

- Documented the canonical `ContractEvent`, `ContractCommand`, `ContractQuery`, and generic `Contract({ kind })` API.
- Documented `visibility`, `tags`, `kind`, and `contracts.outputs[]` output selection for public/internal contract generation.
- Documented source-aware decorator matching, named import aliases, import-free comment markers, and current namespace import limitations.
- Documented fail-fast `BoundaryViolationError` behavior for strict output selectors.

### Changed

- Marked `Public*` decorators and markers as deprecated compatibility aliases in the public docs.
- Documented TypeScript printer diff churn when `removeDecorators: true` rewrites generated files.
- Documented that trusted decorator-only local barrels are skipped from generated output when `removeDecorators: true`.
- Updated the `@hexaijs/contracts` dependency to `^0.3.0`.

### Fixed

- Aligned `tags.include` filtering with documented OR semantics: contracts now match when they have at least one included tag.
- Strict output selectors now fail fast with `BoundaryViolationError` instead of silently copying marked declarations outside the selected public/internal boundary.
- Trusted decorator-only local barrels are skipped from generated output when `removeDecorators: true`.

### Known Follow-up

- Generation failures are not fully atomic yet and may leave partial selected output after `BoundaryViolationError`.

## [0.4.1] - 2026-05-29

### Changed

- Widened the TypeScript peer dependency to support both TypeScript 5 and 6.

## [0.4.0] - 2026-05-28

### Added

- Added `entryStrategy: "symbols" | "graph"` for explicit entry file generation behavior.
- Added default `symbols` extraction for selected public messages and public contracts.
- Added explicit `graph` opt-in for conservative entry file graph copying.
- Added support for `PublicContract` class decorators and block comment markers.
- Added symbol dependency extraction for default imports, namespace imports, aliased named imports, mixed imports, type-only default imports, and qualified namespace references.

### Changed

- Changed the public default entry strategy from graph copying to strict symbol extraction.
- Preserved same-file command/query response contracts in default `symbols` output when discovered by explicit decorator response options or response naming conventions.
- Limited `MessageRegistry` generation to selected decorated messages while keeping general public contracts out of the registry.
- Updated the `@hexaijs/contracts` dependency to `^0.2.0`.

## [0.3.0] - 2026-05-28

### Added

- Added comment-based `@PublicContract()` markers for general public contracts.
- Added support for leading line and JSDoc public contract comments before `class`, `interface`, `type`, and `enum` declarations.
- Added public contract extraction that copies, exports, and barrel-exports marked declarations without registering them in `MessageRegistry`.
- Added public-contract-only file extraction that excludes unmarked declarations.
- Added `contractMarkerNames.contract` configuration for custom public contract marker names.
- Extended programmatic APIs with `includePublicContracts`, `publicContracts`, and `contractMarkerNames`.
- Added CLI options for `--include all|messages|contracts`, `--messages`, `--registry`, `--dry-run`, and `--check`.
- Added tests and documentation for public contract extraction and CLI usability.

### Changed

- Kept `-m, --message-types` and `--generate-message-registry` backwards-compatible while recommending `--messages` and `--registry`.
- Updated the Hexai CLI plugin to use the same contract inclusion, message filtering, registry, dry-run, and check semantics.
- Ensured public contracts are never registered in `MessageRegistry`; only decorated messages are registered.

## [0.2.3] - 2026-03-25

### Fixed

- Make `RegistryGenerator.generate()` output deterministic by sorting contexts by name and messages by name within each context
- Use Unicode codepoint comparison instead of `localeCompare` to guarantee consistent ordering across locales and environments

## [0.2.2] - 2026-03-07

### Changed

- Build tool migrated from tsup to tsgo (`@typescript/native-preview`)
- Module resolution switched to `nodenext` with explicit `.js` import extensions
- Removed path aliases (`@/*`) in favor of relative imports
- ESM-only output (CJS removed)
- Use `createRequire` for ESM-compatible `require()` in config-loader
