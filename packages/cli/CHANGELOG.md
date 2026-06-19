# Changelog

## [0.2.3] - 2026-06-19

### Changed

- Peer dependency: `typescript` `^5.0.0` → `^5.0.0 || ^6.0.0` (allow TypeScript 6 consumers)

## [0.2.2] - 2026-03-07

### Changed

- Build tool migrated from tsup to tsgo (`@typescript/native-preview`)
- Module resolution switched to `nodenext` with explicit `.js` import extensions
- Removed path aliases (`@/*`) in favor of relative imports
- ESM-only output (CJS removed)
- Use `createRequire` for ESM-compatible `require()` in config-loader
