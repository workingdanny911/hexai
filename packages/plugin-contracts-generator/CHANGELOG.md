# Changelog

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
