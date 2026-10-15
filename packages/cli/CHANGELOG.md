# Changelog

## [0.2.4] - 2026-10-15

### Fixed

- `hexai --version` now prints the installed version. It printed the
  hardcoded `0.1.0` in every release.
- Importing `@hexaijs/cli` no longer throws when Node.js has no entry
  script, as in a REPL or `node -e`. The check for whether the CLI was run
  directly passed `process.argv[1]` to `realpathSync()` even when it was
  undefined.

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
