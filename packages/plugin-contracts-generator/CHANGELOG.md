# Changelog

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
