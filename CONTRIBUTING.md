# Contributing to hexai

This guide explains how to set up the repository, build it, run the tests and prepare a change. For what each package does, see the [README](./README.md).

## Repository layout

The repository is a pnpm workspace: every directory under `packages/` is one package (see `pnpm-workspace.yaml`).

- Each published package has `src/`, `README.md`, `CHANGELOG.md` and two TypeScript configs: `tsconfig.json` covers the code and its tests (see [Type check and lint](#type-check-and-lint)), and `tsconfig.build.json` builds `dist/` without the tests.
- Tests sit next to the code they test, as `*.spec.ts` or `*.test.ts` files. `@hexaijs/plugin-contracts-generator` also has end-to-end tests in `e2e/`.
- `packages/tooling` (`@hexaijs/tooling`) is private and never published. It holds the shared TypeScript configs (`tsconfig/base.json` and `tsconfig/node.json`) that the packages extend.

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | CI tests on Node.js 24 and 26. |
| pnpm | The version in the `packageManager` field of the root `package.json`, currently `pnpm@11.8.0`. |
| PostgreSQL | Needed only for the `@hexaijs/postgres` tests. CI tests on PostgreSQL 17 and 18. |

## Install

```bash
pnpm install
```

`@hexaijs/sqlite` uses `better-sqlite3`, whose install script downloads or compiles a native module. `pnpm-workspace.yaml` allows that script to run.

## Build

```bash
pnpm build
```

`pnpm build` deletes every `dist/` directory under `packages/`, builds `@hexaijs/core` and `@hexaijs/utils`, and then builds every package. Each package builds with `tsgo -p tsconfig.build.json`; `tsgo` is the TypeScript native compiler preview from `@typescript/native-preview`.

To build one package:

```bash
pnpm --filter @hexaijs/postgres build
```

## Test

```bash
pnpm test
```

`pnpm test` runs `vitest run` in every package that has a `test` script, which is every package except `@hexaijs/utils` and `@hexaijs/tooling`.

Build before you test. Some tests import other workspace packages, and those imports resolve to the packages' built `dist/`. After you change a package, rebuild it before you run the tests of packages that import it.

To run the tests of one package, or one test file:

```bash
pnpm --filter @hexaijs/sqlite test
pnpm --filter @hexaijs/sqlite exec vitest run src/sqlite-unit-of-work.spec.ts
```

### PostgreSQL for the `@hexaijs/postgres` tests

The `@hexaijs/postgres` tests need a PostgreSQL server. They read its URL from `HEXAI_DB_URL`.

1. Copy the template:

   ```bash
   cp packages/postgres/.env.example packages/postgres/.env
   ```

2. Set `HEXAI_DB_URL` in `packages/postgres/.env` to a server you can use for tests. The tests connect to the server's `postgres` database, whatever database the URL names, and create and drop their own `test_hexai__*` databases. The user therefore needs the `CREATEDB` privilege.

3. Run the tests:

   ```bash
   pnpm --filter @hexaijs/postgres test
   ```

`packages/postgres/vitest.setup.js` loads `.env` and then `.env.test`, which overrides `.env`. A variable set in your shell overrides both files:

```bash
HEXAI_DB_URL=postgres://hexai:hexai@localhost:5432/hexai pnpm --filter @hexaijs/postgres test
```

Without `HEXAI_DB_URL`, only the projection integration tests (`src/projection/projection-integration.test.ts`) skip themselves. The other database tests fail with a `ConfigValidationError`.

CI runs PostgreSQL in a container with user `hexai`, password `hexai` and database `hexai`, and sets `HEXAI_DB_URL=postgres://hexai:hexai@localhost:5432/hexai`. To run the same server locally with Docker:

```bash
docker run --rm -p 5432:5432 \
    -e POSTGRES_USER=hexai -e POSTGRES_PASSWORD=hexai -e POSTGRES_DB=hexai \
    postgres:18
```

## Type check and lint

```bash
pnpm typecheck
pnpm lint
```

- `pnpm typecheck` runs `tsgo -p tsconfig.json --noEmit` in every package, so it checks the tests as well as the code. Like the tests, it reads other workspace packages from their built `dist/`, so build first.
- `@hexaijs/plugin-application-builder` and `@hexaijs/plugin-contracts-generator` leave their fixture projects out of `tsconfig.json`. The generators read those files as input, and some are invalid on purpose.
- `pnpm lint` runs ESLint with the root `.eslintrc.js` on `packages/*/src`. It skips tests (`*.spec.ts`, `*.test.ts`) and fixture directories. A parameter whose name starts with `_` may stay unused.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on every push to `master`. Its two `test` jobs, one on Node.js 24 with PostgreSQL 17 and one on Node.js 26 with PostgreSQL 18, each run:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

A third job, `check`, runs once on Node.js 26:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
```

- `--frozen-lockfile` fails when `pnpm-lock.yaml` does not match the package manifests, so commit the updated lockfile with any dependency change.
- Each job reports on its own: a failing job does not cancel the others. A job stops after 30 minutes.
- CI does not check formatting.

## Code style

`.prettierrc.js` sets four-space indentation, semicolons and ES5 trailing commas. Prettier is a root dev dependency, but there is no format script. To format a file:

```bash
pnpm exec prettier --write <file>
```

Many existing files do not match this configuration yet, so formatting a whole file can change lines you did not touch. Keep such formatting-only changes out of unrelated work.

## Documentation and changelogs

Each package's `README.md` documents its public API. When you change what a package does, update its README and its `CHANGELOG.md` with the change.

Every published package keeps a `CHANGELOG.md` with one section per release, newest first:

```markdown
# Changelog

## [0.16.0] - 2026-10-13

### Added

- Added `db` to `PostgresUnitOfWork`, ...

### Deprecated

- Deprecated `withClient()` and `getClient()`. ...
```

- The heading of a release is `## [<version>] - <YYYY-MM-DD>`.
- Entries are grouped under `### Added`, `### Changed`, `### Deprecated`, `### Removed` and `### Fixed`. A release with breaking changes also has `### Breaking Changes`, and some releases add migration notes or other notes.
- Entries name the API they affect and describe the change in full sentences, as recent releases do (see `packages/postgres/CHANGELOG.md`).
