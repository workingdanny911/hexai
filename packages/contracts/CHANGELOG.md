# Changelog

## [0.2.0] - 2026-05-28

### Added

- Added the `PublicContract` marker decorator for general public contract classes.
- Exported `PublicContract` from both the package root and `@hexaijs/contracts/decorators`.

## [0.1.2] - 2026-03-07

### Changed

- Build tool migrated from tsup to tsgo (`@typescript/native-preview`)
- Module resolution switched to `nodenext` with explicit `.js` import extensions
- ESM-only output (CJS removed)
- Peer dependency: `@hexaijs/core` `^0.6.0` → `^0.9.0`
