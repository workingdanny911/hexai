# Changelog

## [0.3.3] - 2026-10-15

### Changed

- The package no longer ships `dist/test.js`, a test helper for this
  package's own tests. It was never exported.

### Fixed

- `generate-app-builder --context-path` without a value now says the option
  expects a directory path. The message said it expected `"js"` or
  `"extensionless"`, the values of `--output-module-specifiers`.

## [0.3.2] - 2026-10-15

### Changed

- Peer dependency: `@hexaijs/core` `^0.9.0 || ^0.10.0` → `^0.9.0 || ^0.10.0 || ^0.11.0 || ^0.12.0`
- Peer dependency: `@hexaijs/application` `^0.5.0` → `^0.5.0 || ^0.6.0`

## [0.3.1] - 2026-06-24

### Changed

- Peer dependency: `@hexaijs/core` `^0.9.0` → `^0.9.0 || ^0.10.0`

## [0.3.0] - 2026-06-22

### Added

- Added `outputModuleSpecifiers` configuration for generated relative imports, with `"js"` as the default and `"extensionless"` as the legacy opt-out.
- Added CLI, programmatic API, and Hexai CLI plugin overrides for generated module specifier style.

### Changed

- Generated relative imports now default to explicit `.js` extensions for NodeNext and ESM runtime compatibility.

### Fixed

- Fixed generated ApplicationBuilder output for NodeNext projects by producing runtime-valid relative import specifiers.

## [0.2.5] - 2026-06-19

### Changed

- Peer dependency: `typescript` `^5.0.0` → `^5.0.0 || ^6.0.0` (allow TypeScript 6 consumers)

## [0.2.4] - 2026-03-07

### Changed

- Build tool migrated from tsup to tsgo (`@typescript/native-preview`)
- Module resolution switched to `nodenext` with explicit `.js` import extensions
- Removed path aliases (`@/*`) in favor of relative imports
- ESM-only output (CJS removed)
- Use `createRequire` for ESM-compatible `require()` in config-loader
- Peer dependency: `@hexaijs/core` `^0.8.0` → `^0.9.0`
