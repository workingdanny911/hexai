# Architecture

This guide explains how the contracts generator is built: its modules, the order in which they run, and the rules each one enforces. It is for contributors. To use the generator, read the [README](../README.md); for the data the modules pass around, read the [domain model guide](./DOMAIN-MODEL.md).

## Contents

1. [Source layout](#1-source-layout)
2. [Pipeline overview](#2-pipeline-overview)
3. [Entry points](#3-entry-points)
4. [Configuration](#4-configuration)
5. [Scanner](#5-scanner)
6. [Parser and marker matching](#6-parser-and-marker-matching)
7. [Selection](#7-selection)
8. [File graph resolver](#8-file-graph-resolver)
9. [File copier](#9-file-copier)
10. [Dependency symbol slicer](#10-dependency-symbol-slicer)
11. [Module specifiers](#11-module-specifiers)
12. [Registry generation and runtime](#12-registry-generation-and-runtime)
13. [Re-export generation](#13-re-export-generation)
14. [Infrastructure](#14-infrastructure)
15. [Module dependencies](#15-module-dependencies)
16. [Tests](#16-tests)

## 1. Source layout

```text
src/
├── index.ts                      # package entry: processContext() and re-exports
├── cli.ts                        # generate-contracts binary: run(), runWithConfig()
├── hexai-plugin.ts               # cliPlugin for @hexaijs/cli
├── config-loader.ts              # application.config.ts loading and validation
├── context-config.ts             # ContextConfig: source directory and tsconfig path aliases
├── pipeline.ts                   # ContractsPipeline: one context, one output
├── scanner.ts                    # finds entry files
├── parser.ts                     # builds the domain model from one entry file
├── contract-decorator-matcher.ts # decides which decorators and comments are markers
├── contract-selector.ts          # applies outputs[].select to one contract
├── file-graph-resolver.ts        # import graph from the entry files
├── file-copier.ts                # entry extraction, transformations, writing files
├── dependency-symbol-slicer.ts   # safe-symbols slicing of dependency files
├── module-specifier.ts           # ".js" or extensionless relative specifiers
├── registry-generator.ts         # root index.ts with MessageRegistry
├── reexport-generator.ts         # re-export files for pathAliasRewrites
├── ast-utils.ts                  # TypeNode to TypeRef, payload fields
├── import-analyzer.ts            # import bindings and ClassImport lists
├── class-analyzer.ts             # class source text, base class, export modifier
├── errors.ts                     # error hierarchy
├── file-system.ts                # FileSystem interface and nodeFileSystem
├── logger.ts                     # Logger, ConsoleLogger, noopLogger
├── test-utils.ts                 # in-memory file system and model builders for tests
├── domain/
│   ├── index.ts
│   └── types.ts                  # the domain model
└── runtime/
    ├── index.ts                  # the @hexaijs/plugin-contracts-generator/runtime entry
    └── message-registry.ts
```

Unit tests sit next to their modules as `*.test.ts`. See [Tests](#16-tests) for the rest.

`package.json` exposes two entry points, `.` (`dist/index.js`) and `./runtime` (`dist/runtime/index.js`), and the `generate-contracts` binary (`dist/cli.js`). A module's exports are public only when `index.ts` or `runtime/index.ts` re-exports them.

## 2. Pipeline overview

The CLI and the hexai plugin drive one `ContractsPipeline` per context and output, then write the files that span contexts. `processContext()` drives a single pipeline.

```text
run(args)                       runWithConfig(options, pluginConfig)       processContext(options)
  │ ConfigLoader.load()           │ toContractsConfig()                      │ ContextConfig.create()
  └──────────────┬────────────────┘                                          │
                 ▼                                                           │
        runGeneration()                                                      │
          resolveGenerationScope()   --include, --messages                   │
          createOutputPlans()        -o, or one plan per outputs[] entry     │
          temporary plans            for --dry-run and --check               │
          for each output plan:                                              │
            for each context:                                                │
              ContractsPipeline.create(...).execute(...)  ◄──────────────────┘
            RegistryGenerator   ->  <output>/index.ts          (registry on)
            ReexportGenerator   ->  re-export files            (pathAliasRewrites set)
          --dry-run: log files    --check: compare temporary and real outputs
```

`ContractsPipeline.execute()` runs these steps for one context and writes to `<outputDir>/<contextName>/`:

| Step | Method | Output |
|------|--------|--------|
| Scan | `scan(sourceDir)` via `Scanner` | Paths of candidate entry files. |
| Parse | `parse(files, sourceDir)` via `Parser` | `ParsedMessages`: messages, general contracts, type definitions. |
| Select | `selectMessages()` via `isContractSelected()` | The contracts the output selects. A no-op without `select`. |
| Collect entry points | `collectEntryPoints()` | Files that still hold a selected contract. |
| Resolve | `resolve(entryPoints, sourceDir)` via `FileGraphResolver` | `FileGraph` of entry files and their local imports. |
| Plan exports | `collectResponseTypesToInclude()`, `collectResponseTypesToExport()`, `collectPublicContractsToExport()` | Same-file response types to keep; response types and general contracts that need `export`. |
| Copy | `copy(...)` via `FileCopier.copyFiles()` | Written files (`copiedFiles`). |
| Barrel | `exportBarrel(copiedFiles, contextOutputDir)` | `<context>/index.ts`. |

The pipeline logs the start and end of each context at `info` level and every step at `debug` level.

```typescript
class ContractsPipeline {
  static create(options: {
    contextConfig: ContextConfig;
    responseNamingConventions?: readonly ResponseNamingConvention[];
    fileSystem?: FileSystem;                 // default nodeFileSystem
    logger?: Logger;                         // default noopLogger
    excludeDependencies?: string[];          // default: see section 8
    decoratorNames?: DecoratorNames;
    contractMarkerNames?: ContractMarkerNames;
    trustedDecoratorSources?: TrustedDecoratorSources;
    messageTypes?: MessageType[];            // default: all
    includePublicContracts?: boolean;        // default true
    dependencyStrategy?: DependencyStrategy; // default "safe-symbols"
    outputModuleSpecifiers?: OutputModuleSpecifiers; // default "js"
  }): ContractsPipeline;

  static fromDependencies(deps: PipelineDependencies): ContractsPipeline;

  execute(options: PipelineOptions): Promise<PipelineResult>;
  scan(sourceDir: string): Promise<string[]>;
  parse(files: string[], sourceRoot: string): Promise<ParsedMessages>;
  resolve(entryPoints: string[], sourceRoot: string): Promise<FileGraph>;
  copy(
    fileGraph: FileGraph,
    sourceRoot: string,
    outputDir: string,
    pathAliasRewrites?: Map<string, string>,
    responseTypesToExport?: Map<string, string[]>,
    publicContractsToExport?: Map<string, string[]>,
    responseTypesToInclude?: Map<string, string[]>,
    removeDecorators?: boolean,
    messageTypes?: readonly MessageType[],
    dependencyStrategy?: DependencyStrategy,
    select?: ContractOutputSelect,
    outputModuleSpecifiers?: OutputModuleSpecifiers
  ): Promise<string[]>;
  exportBarrel(
    copiedFiles: string[],
    outputDir: string,
    outputModuleSpecifiers?: OutputModuleSpecifiers
  ): Promise<void>;
}

interface PipelineDependencies {
  readonly scanner: Scanner;
  readonly parser: Parser;
  readonly fileGraphResolver: FileGraphResolver;
  readonly fileCopier: FileCopier;
  readonly fileSystem: FileSystem;
  readonly logger: Logger;
}

interface PipelineOptions {
  readonly contextName: string;
  readonly sourceDir: string;
  readonly outputDir: string;
  readonly pathAliasRewrites?: Map<string, string>;
  readonly select?: ContractOutputSelect;
  readonly removeDecorators?: boolean;
  readonly outputModuleSpecifiers?: OutputModuleSpecifiers;
}
```

`create()` rejects an `entryStrategy` option with `ConfigurationError` and validates `dependencyStrategy`. `fromDependencies()` injects the stages directly for tests; the instance then uses the defaults for every other setting. `ParsedMessages` and `PipelineResult` are described in [Results](./DOMAIN-MODEL.md#8-results).

## 3. Entry points

### Standalone CLI (`src/cli.ts`)

`dist/cli.js` calls `main()` only when it is the process entry. `main()` runs `run(process.argv.slice(2))`, prints `Error: <message>` for any thrown error and exits with code 1.

```typescript
function run(args: string[]): Promise<void>;
function runWithConfig(
  options: RunWithConfigOptions,
  pluginConfig: ContractsPluginConfig
): Promise<void>;

type IncludeMode = "all" | "messages" | "contracts";

interface RunWithConfigOptions {
  outputDir?: string;
  include?: IncludeMode;
  messageTypes?: MessageType[];
  dependencyStrategy?: DependencyStrategy;
  outputModuleSpecifiers?: OutputModuleSpecifiers;
  generateMessageRegistry?: boolean;
  dryRun?: boolean;
  check?: boolean;
}
```

`ContractsPluginConfig` has the same fields as the `contracts` section of `application.config.ts`. These exports are internal: the package exports map does not expose `cli.js`.

- **Argument parsing.** `parseArgs()` accepts `--flag value` and `--flag=value` and ignores unknown arguments. It throws a plain `Error` for a missing value, an invalid `--include` or `--messages` value, or the removed `--entry-strategy`. Invalid `--dependency-strategy` and `--output-module-specifiers` values go through the config validators and throw `ConfigLoadError`. The [README](../README.md#standalone-cli) lists the flags.
- **Scope.** `resolveGenerationScope()` maps the flags to pipeline options:

  | `--include` | `messageTypes` | `includePublicContracts` |
  |-------------|----------------|--------------------------|
  | `all` (default) | the `--messages` value, or all | `true` |
  | `messages` | the `--messages` value, or all | `false` |
  | `contracts` | `[]` | `true` |

- **Output plans.** `createOutputPlans()` returns one plan per `contracts.outputs[]` entry, or a single plan named `default` from `-o`. It throws when both or neither are given. Plan paths resolve against `config.configDir`. A plan's registry is on when `--registry` is set or the output sets `registry: true`.
- **Precedence.** Module specifiers: output plan, then the CLI flag, then the config. Dependency strategy: the CLI flag, then the config.
- **`--dry-run` and `--check`.** `createTemporaryOutputPlans()` points every plan at `<tmp>/<plan name>`. After generation, `--dry-run` logs each context's files, and `--check` compares each temporary directory with the real one file by file (`assertOutputMatchesGenerated()`). It lists up to 20 missing, extra and changed files per category and throws a plain `Error`. The temporary directory is removed in a `finally` block.
- **Cross-context files.** After all contexts of a plan, `generateRegistry()` runs when the registry is on, and `generateReexports()` runs when `pathAliasRewrites` is set.

### hexai plugin (`src/hexai-plugin.ts`)

`cliPlugin` is a `HexaiCliPlugin<ContractsPluginConfig>` named `generate-contracts`. Its options mirror the standalone flags except `-c`. `run(args, config)` converts Commander's camelCase arguments into `RunWithConfigOptions` and calls `runWithConfig()`.

`toContractsConfig()` turns the plugin config into a `ContractsConfig`. It uses `process.cwd()` as `configDir`, applies the same validators as the config loader, defaults `removeDecorators` to `true`, and rejects `entryStrategy` with a plain `Error`.

### Programmatic API (`src/index.ts`)

`processContext(options)` rejects `entryStrategy` with `ConfigurationError`, creates a `ContextConfig` relative to `process.cwd()`, and runs one pipeline. It does not generate a registry or re-export files. Unlike the CLI, it leaves `removeDecorators` unset, so decorators stay in the output by default. The [README](../README.md#programmatic-api) lists the options.

`index.ts` re-exports `cliPlugin` from `hexai-plugin.ts`, which imports `cli.ts`, which imports `ContractsPipeline` and `ConsoleLogger` from `index.ts`. The cycle works because no module calls into the others at load time; keep it that way.

## 4. Configuration

### Config loader (`src/config-loader.ts`)

```typescript
interface ContractsConfig {
  readonly configDir: string;
  readonly contexts: readonly ContextConfig[];
  readonly outputs?: readonly ContractOutputConfig[];
  readonly pathAliasRewrites?: Readonly<Record<string, string>>;
  readonly externalDependencies?: Readonly<Record<string, string>>;
  readonly decoratorNames: Required<DecoratorNames>;
  readonly contractMarkerNames: Required<ContractMarkerNames>;
  readonly trustedDecoratorSources?: TrustedDecoratorSources;
  readonly dependencyStrategy: DependencyStrategy;
  readonly outputModuleSpecifiers: OutputModuleSpecifiers;
  readonly responseNamingConventions?: readonly ResponseNamingConvention[];
  readonly removeDecorators?: boolean;
}

class ConfigLoader {
  constructor(options?: { fileSystem?: FileSystem });
  load(configPath: string): Promise<ContractsConfig>;
}

function resolveContextEntries(
  entries: readonly (string | InputContextConfig)[],
  configDir: string,
  fs?: FileSystem
): Promise<ContextConfig[]>;
```

`load()` reads the file, transpiles it with `ts.transpileModule()` to CommonJS, and evaluates the result with `new Function("exports", code)`. No `require` exists in that scope, so a config with runtime imports fails. The default export (or the `exports` object) must contain a `contracts` section. `extractContractsConfig()` then:

1. requires `contracts` and an array `contracts.contexts`, and rejects `entryStrategy`;
2. resolves contexts with `resolveContextEntries()` and requires at least one;
3. merges `decoratorNames` and `contractMarkerNames` with the legacy defaults;
4. validates `outputs` (`validateContractOutputs()`), `trustedDecoratorSources`, `dependencyStrategy` and `outputModuleSpecifiers`, filling the defaults `"safe-symbols"` and `"js"`;
5. defaults `removeDecorators` to `true`.

All validation failures throw `ConfigLoadError`. The `validate*()` functions are exported for `cli.ts` and `hexai-plugin.ts`; the package root exports only `ConfigLoader`, `resolveContextEntries` and `ContractsConfig`. `externalDependencies` is stored and never read.

`resolveContextEntries()` handles three entry shapes:

- **Plain string**: one context named after the last path segment.
- **String with `*`**: exactly one `*` is allowed. The prefix names a directory to list; each subdirectory becomes a context named after itself. A non-empty suffix keeps only subdirectories that contain that path. A missing prefix directory yields no contexts.
- **Object**: requires `name` and `path` (else `ConfigLoadError`), then calls `ContextConfig.create()`.

### Context config (`src/context-config.ts`)

```typescript
interface InputContextConfig {
  readonly name: string;
  readonly path: string;
  readonly sourceDir?: string;          // default "src", relative to path
  readonly tsconfigPath?: string;       // default "tsconfig.json", relative to path
  readonly responseNamingConventions?: readonly ResponseNamingConvention[];
}

class ContextConfig {
  readonly name: string;
  readonly sourceDir: string;           // absolute
  readonly responseNamingConventions?: readonly ResponseNamingConvention[];

  static create(input: InputContextConfig, configDir: string, fs?: FileSystem): Promise<ContextConfig>;
  static createSync(
    name: string,
    sourceDir: string,
    fs?: FileSystem,
    responseNamingConventions?: readonly ResponseNamingConvention[]
  ): ContextConfig;                     // no tsconfig; used by tests

  resolvePath(moduleSpecifier: string): Promise<{ resolvedPath: string | null; isExternal: boolean }>;
}
```

`create()` throws a plain `Error` when `name` or `path` is missing. It loads the tsconfig only when the file exists, through `ts.parseConfigFileTextToJson()` and `ts.parseJsonConfigFileContent()`, so `extends` chains are honored. It keeps only `compilerOptions.paths`, resolved against `baseUrl` (or the tsconfig directory).

`resolvePath()` handles non-relative specifiers. The first `paths` pattern that matches wins (no longest-prefix ordering). Each target is tried with `.ts`, `.tsx`, `.d.ts` and `/index.ts`; a hit inside `sourceDir` is local. Anything else is external.

The pipeline prefers the top-level `responseNamingConventions` and falls back to the context's own list.

## 5. Scanner

`src/scanner.ts` finds candidate entry files cheaply; the parser makes the final decision.

```typescript
interface ScannerOptions {
  exclude?: string[];                   // default below
  fileSystem?: FileSystem;
  decoratorNames?: DecoratorNames;
  contractMarkerNames?: ContractMarkerNames;
  messageTypes?: MessageType[];         // default: all
  includePublicContracts?: boolean;     // default: messageTypes === undefined
  trustedDecoratorSources?: TrustedDecoratorSources;
}

class Scanner {
  constructor(options?: ScannerOptions);
  scan(sourceDir: string): Promise<string[]>;
}
```

`scan()` globs `<sourceDir>/**/*.ts`, excluding `**/node_modules/**`, `**/dist/**`, `**/*.d.ts`, `**/*.test.ts` and `**/*.spec.ts`. A file is a candidate when either check passes:

1. **Text patterns.** A line starts with `@<name>`, where `<name>` is the legacy decorator name of a selected message type. With general contracts included, two more patterns count: a line that starts with `@<contract marker name>`, and a comment line (`//`, `/*`, `/**` or `*`) that holds `@<contract marker name>(` or `@Contract(`.
2. **Matcher.** The file contains `@` and the text of a trusted decorator source. The scanner then parses it and asks `ContractDecoratorMatcher` for a class decorator of a selected message kind, a non-message class decorator, or a non-message comment marker on a class, interface, type alias or enum.

Canonical `Contract*` decorators are found only by the second check, so a file must name a trusted source in its text.

## 6. Parser and marker matching

### Parser (`src/parser.ts`)

```typescript
interface ParserOptions {
  decoratorNames?: DecoratorNames;
  contractMarkerNames?: ContractMarkerNames;
  responseNamingConventions?: readonly ResponseNamingConvention[];
  messageTypes?: readonly MessageType[];
  includePublicContracts?: boolean;     // default: messageTypes === undefined
  trustedDecoratorSources?: TrustedDecoratorSources;
}

class Parser {
  constructor(options?: ParserOptions);
  parse(sourceCode: string, sourceFileInfo: SourceFile): ParseResult;
}
```

`parse()` walks every node of the file:

- **Classes.** Each decorator that the matcher resolves to a message kind in `messageTypes` produces a message (`buildMessage()`). With general contracts included, a non-message decorator, or else a non-message leading comment marker, produces a general contract.
- **Type aliases and interfaces.** Each produces a `TypeDefinition`. With general contracts included, a non-message leading comment marker also produces a general contract.
- **Enums.** With general contracts included, a non-message leading comment marker produces a general contract.

After the walk, `applyNamingConventionMatching()` sets `resultType` on commands and queries without a `response` option. The [domain model guide](./DOMAIN-MODEL.md#4-messages) lists how each message field is filled.

The parser trusts only `@hexaijs/contracts`, `@hexaijs/contracts/decorators` and the configured sources. `FileCopier` additionally trusts `@hexaijs/plugin-contracts-generator`, so a canonical decorator imported from the generator package is not counted as a contract but is still extracted when its file is an entry file for another reason. Keep the two lists in sync when you change either.

### Marker matching (`src/contract-decorator-matcher.ts`)

`ContractDecoratorMatcher` is the single interpreter of markers for the scanner, parser and copier.

```typescript
interface ContractDecoratorMatcherOptions {
  readonly trustedDecoratorSources?: readonly string[];
  readonly decoratorNames?: DecoratorNames;
  readonly contractMarkerName?: string;
  readonly allowUnboundDecorators?: boolean;   // default false
}

class ContractDecoratorMatcher {
  constructor(options?: ContractDecoratorMatcherOptions);
  buildImportBindingIndex(sourceFile: ts.SourceFile): ReadonlyMap<string, ImportBinding>;
  matchDecorator(
    decorator: ts.Decorator,
    bindingsOrSourceFile: ReadonlyMap<string, ImportBinding> | ts.SourceFile
  ): ContractDecoratorMatch | undefined;
  matchLeadingCommentMarker(node: ts.Node, sourceFile: ts.SourceFile): ContractCommentMarkerMatch | undefined;
  matchCommentText(text: string, range?: ts.CommentRange): ContractCommentMarkerMatch | undefined;
}
```

The matcher holds one definition per recognized name:

| Name | Canonical name | Kind | Legacy |
|------|----------------|------|--------|
| `Contract` | `Contract` | from the `kind` option, default `contract` | no |
| `ContractCommand`, `ContractQuery`, `ContractEvent` | itself | `command`, `query`, `event` | no |
| `decoratorNames.command`, `.query`, `.event` (default `PublicCommand`, `PublicQuery`, `PublicEvent`) | `ContractCommand`, `ContractQuery`, `ContractEvent` | `command`, `query`, `event` | yes |
| `contractMarkerName` (default `PublicContract`) | `Contract` | from the `kind` option, default `contract` | yes |

`matchDecorator()` accepts `@Name` and `@Name(...)` where `Name` is an identifier; property accesses such as `@Contracts.ContractCommand()` never match. It resolves the definition through the import binding of the local name:

- **No binding**: matches legacy names, canonical names that are also configured as custom names, and, with `allowUnboundDecorators`, every defined name.
- **Named, value import from a trusted source**: matches the definition of the imported name, so aliases work.
- **Any other binding** (untrusted source, type-only, default or namespace import): matches only when the local name is a legacy name.

`matchLeadingCommentMarker()` reads the leading comments of a node. `matchCommentText()` strips comment syntax from each line and accepts a line that is exactly `@Name(...)` for any defined name, canonical names included.

Marker options are parsed from the first argument (decorators) or the parenthesized text (comments) when it is an object literal. Only property assignments with identifier or string names count, and only string, number, boolean and array literal values; anything else becomes `undefined`. `visibility` is `internal` only for the literal `"internal"`.

## 7. Selection

`src/contract-selector.ts` implements output selection:

```typescript
interface SelectableContract {
  readonly name: string;
  readonly contractType?: "message" | "contract";
  readonly kind?: ContractKind;
  readonly messageType?: MessageContractKind;
  readonly visibility?: ContractVisibility;
  readonly tags?: readonly string[];
}

function isContractSelected(contract: SelectableContract, select: ContractOutputSelect | undefined): boolean;
function hasStrictOutputSelection(select: ContractOutputSelect | undefined): boolean;
```

`isContractSelected()` returns `true` without a `select`, and otherwise requires every set field to match (the [README](../README.md#multiple-outputs) describes each field). Three places call it with the same `select`:

1. `ContractsPipeline.selectMessages()` filters the parsed views, which decides entry points, export repair, registry content and result counts.
2. `FileCopier.findTargetDeclarations()` filters the declarations it extracts from each entry file.
3. `FileCopier.assertSelectedBoundary()` checks every file about to be written, but only when `hasStrictOutputSelection()` is `true` (any `select` field is set). Any marked declaration in the file that the selection rejects raises `BoundaryViolationError`, which names each offending declaration with its kind and visibility.

## 8. File graph resolver

`src/file-graph-resolver.ts` builds the import graph that the copier walks.

```typescript
interface FileGraphResolverOptions {
  contextConfig: ContextConfig;
  fileSystem?: FileSystem;
  excludeDependencies?: string[];       // default [] here; the pipeline passes its own list
}

interface ImportInfo {
  moduleSpecifier: string;
  resolvedPath: string | null;
  isExternal: boolean;
  importedNames: string[];
}

interface FileNode {
  absolutePath: string;
  relativePath: string;                 // relative to the context source directory
  imports: ImportInfo[];
  isEntryPoint: boolean;
}

interface FileGraph {
  nodes: Map<string, FileNode>;
  entryPoints: Set<string>;
  excludedPaths: Set<string>;
}

class FileGraphResolver {
  static create(options: FileGraphResolverOptions): FileGraphResolver;
  buildGraph(entryPoints: string[], sourceRoot: string): Promise<FileGraph>;
}
```

`buildGraph()` walks breadth-first from the entry files. For each file it reads every top-level `import` and every `export ... from`:

- **Relative specifiers** resolve to `<path>.ts`, `<path>.tsx` or `<path>/index.ts`. A specifier ending in `.js`, `.mjs` or `.cjs` resolves to the `.ts` or `.tsx` file with the same base name, without the index fallback. An unresolved relative specifier gets `resolvedPath: null` and is not followed.
- **Other specifiers** go through `ContextConfig.resolvePath()` (see [Context config](#context-config-srccontext-configts)). Local hits are followed; the rest are external.
- **Excluded files** match an `excludeDependencies` pattern (minimatch with `matchBase`, against the absolute path). They land in `excludedPaths` and are not followed. The pipeline passes `**/*.test.ts`, `**/*.spec.ts`, `**/*.eh.ts`, `**/db.ts` and `**/infra/**`.

The graph holds every reachable local file, used or not. The copier decides what to write. A file outside the source directory gets a `relativePath` that starts with `../`.

## 9. File copier

`src/file-copier.ts` turns the graph into output files.

```typescript
interface CopyOptions {
  sourceRoot: string;
  outputDir: string;
  fileGraph: FileGraph;
  pathAliasRewrites?: Map<string, string>;
  removeDecorators?: boolean;
  responseTypesToExport?: Map<string, string[]>;   // file -> unexported response types
  responseTypesToInclude?: Map<string, string[]>;  // file -> response types to keep
  publicContractsToExport?: Map<string, string[]>; // file -> unexported general contracts
  messageTypes?: readonly MessageType[];
  decoratorNames?: DecoratorNames;
  contractMarkerNames?: ContractMarkerNames;
  trustedDecoratorSources?: TrustedDecoratorSources;
  includePublicContracts?: boolean;
  dependencyStrategy?: DependencyStrategy;         // default "safe-symbols"
  select?: ContractOutputSelect;
  outputModuleSpecifiers?: OutputModuleSpecifiers; // default "js"
}

interface CopyResult {
  copiedFiles: string[];
  rewrittenImports: Map<string, string[]>;         // output file -> applied rewrites
}

class FileCopier {
  constructor(options?: { fileSystem?: FileSystem });
  copyFiles(options: CopyOptions): Promise<CopyResult>;
  generateBarrelExport(
    copiedFiles: string[],
    outputDir: string,
    options?: { outputModuleSpecifiers?: OutputModuleSpecifiers }
  ): string;
}
```

`copyFiles()` runs in three phases.

### Phase 1: entry extraction

For every entry node, `preprocessEntryFiles()`:

1. skips the file when `findTargetDeclarations()` finds no selected target in it;
2. extracts the targets with `extractSymbolsFromEntry()` (below);
3. strips markers from a copy of the result when `removeDecorators` is set, so decorator imports do not count as dependencies;
4. with `safe-symbols`, rejects the entry if it still holds a local `import("./x")` type;
5. records the remaining imports that resolve to local, non-entry files as retained imports.

`extractSymbolsFromEntry()` works on the entry file's syntax tree:

1. **Targets.** Message classes whose decorator kind is in `messageTypes`, general contract classes (decorator or comment marker) and marked interfaces, type aliases and enums, each filtered by `select`.
2. **Related names.** Same-file response types from `responseTypesToInclude`, plus fixed names for each target message class `X`: `XResponse` and `XPayload`; when `X` is `<Base>Request`, also `<Base>Response` and `<Base>Payload`; when `X` is `<Base>Query`, also `<Base>QueryResult` and `<Base>Payload`. A related name counts only if the file declares it.
3. **Local closure.** Identifiers used by the targets and related names pull in top-level interfaces, type aliases, variables, classes, functions and enums of the same file, recursively.
4. **Imports.** Only imports that bind a used identifier stay. Default, namespace, aliased, mixed default-and-named and type-only default imports are preserved; unused named specifiers are dropped from mixed imports when the rewrite is safe. Qualified references such as `Types.Inner.User` keep their namespace import.
5. **Emitting.** The output lists the kept imports, then the local declarations, then the targets. Imports and general contract classes go through the TypeScript printer; other declarations are copied as source text. Every emitted declaration without `export` gets one (`appendNodeWithExport()`, `ensureClassExport()`), so private helpers of an entry file become exports of the generated file.

This is syntax-tree expansion, not type-checker analysis.

### Phase 2: dependency planning

- **`safe-symbols`.** Retained imports that point outside the source directory (a `relativePath` starting with `../`) become whole-file dependencies. The rest go to `DependencySymbolSlicer` (section 10), which returns sliced contents and any further whole-file dependencies it met. Whole-file dependencies are expanded transitively through the graph.
- **`file`.** The retained import targets are expanded transitively through the graph, and every file in the set is copied whole.

### Phase 3: writing

For each node of the graph, `resolveNodeContent()` picks the extracted entry content, the whole file, the sliced content or nothing. Then:

1. With `removeDecorators`, a non-entry file that only re-exports decorators from trusted sources is skipped (`isTrustedDecoratorOnlyHelperFile()`).
2. `assertSelectedBoundary()` runs the boundary check (section 7).
3. `applyTransformations()` rewrites the content in this order:
   1. remove imports and exports of excluded files;
   2. with `removeDecorators`, remove marker comments, contract decorators and decorator-only imports (`removeContractDecorators()`); the removal matcher also recognizes the default `PublicContract` name when a custom marker name is configured;
   3. add `export` to the response types in `responseTypesToExport`;
   4. add `export` to the general contracts in `publicContractsToExport`;
   5. rewrite tsconfig path aliases that resolve inside the graph to relative specifiers;
   6. with `js` specifiers, normalize relative specifiers that point at copied files to `.js`;
   7. apply `pathAliasRewrites` as plain-text prefix replacements over the whole file.
4. `writeOutputFile()` writes to `<outputDir>/<relativePath>`, creating directories as needed. Read and write failures become `FileReadError` and `FileWriteError`.

`generateBarrelExport()` returns one `export * from '<specifier>'` line per copied file, sorted, without a trailing newline. The pipeline writes it as `<context>/index.ts`, even when it is empty.

## 10. Dependency symbol slicer

`src/dependency-symbol-slicer.ts` implements `safe-symbols` for dependency files.

```typescript
interface RetainedImportedSymbol {
  readonly importedName: string;
  readonly localName: string;
  readonly importKind: "named" | "default" | "namespace";
  readonly isTypeOnly: boolean;
}

interface RetainedLocalImport {
  readonly sourcePath: string;
  readonly moduleSpecifier: string;
  readonly resolvedPath: string;
  readonly importedSymbols: readonly RetainedImportedSymbol[];
}

interface DependencySliceRequest {
  readonly fileGraph: FileGraph;
  readonly retainedLocalImports: readonly RetainedLocalImport[];
  readonly wholeFileDependencyPaths?: ReadonlySet<string>;
}

interface DependencySliceResult {
  readonly contents: ReadonlyMap<string, string>;
  readonly wholeFileRetainedImports: readonly RetainedLocalImport[];
}

class DependencySymbolSlicer {
  constructor(options: { readonly fileSystem: FileSystem });
  slice(request: DependencySliceRequest): Promise<DependencySliceResult>;
}
```

The slicer keeps a queue of files and, per file, the set of symbols required from it:

1. A retained import into a whole-file path is recorded and not sliced. Any other retained import must be all named imports, or the slicer throws; each imported name becomes a required symbol of the target file.
2. For each queued file, it rejects the file if `findUnsafeReason()` finds an unsafe construct, indexes the top-level declarations (rejecting duplicates), and walks from the required symbols through the identifiers they reference, including values referenced by `typeof`.
3. It keeps the import specifiers the kept declarations use. Named imports of local files enqueue new required symbols there; default and namespace imports that are still needed throw.
4. It prints the kept imports and statements with the TypeScript printer.
5. A file is sliced again when its required set grows; an unchanged set is skipped.

Every rejection throws `UnsafeDependencySliceError(filePath, reason)`. The reasons:

| Reason | Cause |
|--------|-------|
| `local import type: <specifier>` | `import("./x").T` referring to a local file (also checked in entry files). |
| `dynamic import` | `import()` anywhere in the file. |
| `side-effect import` | `import "./setup"`. |
| `export declaration` | `export { ... }`, `export * from`, `export default` or `export =`. |
| `class decorator`, `class member decorator` | Decorators on a class, a member or a constructor parameter. |
| `class heritage/extends` | An `extends` clause that is not a plain identifier or contains an unsafe expression. |
| `class static block`, `class computed member name`, `class static member initializer` | The named class construct. |
| `enum initializer` | Any enum member with an initializer. |
| `unsafe top-level variable initializer` | An initializer containing a call, `new`, tagged template, `await`, `yield`, `delete`, assignment, or `++`/`--`. |
| `top-level statement` | Any other top-level statement, such as an expression statement. |
| `duplicate top-level declaration: <name>` | Two top-level declarations with the same name. |
| `missing required symbol: <name>` | A required symbol is not declared at the top level. |
| `unsupported import shape: default import`, `... namespace import` | A needed default or namespace import. |

## 11. Module specifiers

`src/module-specifier.ts` formats the relative specifiers the generator writes. `DEFAULT_OUTPUT_MODULE_SPECIFIERS` is `"js"`.

| Function | Result |
|----------|--------|
| `formatRelativeTypeScriptFileSpecifier(relativePath, style)` | Drops `.ts`/`.tsx`, ensures a `./` or `../` prefix, appends `.js` in `js` style. |
| `formatRelativePathFromFile(fromFile, toFile, style)` | The specifier from one output file to another. |
| `formatRelativeIndexSpecifier(relativeDir, style)` | `./dir/index.js` in `js` style, `./dir` in `extensionless` style. |
| `formatRelativeModuleSpecifier(specifier, style)` | Appends `.js` in `js` style unless it is already there. |

## 12. Registry generation and runtime

### Registry generator (`src/registry-generator.ts`)

```typescript
interface RegistryGeneratorOptions {
  readonly messageRegistryImport: string;   // default "@hexaijs/plugin-contracts-generator/runtime"
  readonly useNamespace?: boolean;          // default false
  readonly outputModuleSpecifiers?: OutputModuleSpecifiers; // default "js"
}

interface ContextMessages {
  readonly contextName: string;
  readonly events: readonly DomainEvent[];
  readonly commands: readonly Command[];
  readonly queries?: readonly Query[];
  readonly importPath?: string;             // default "./<contextName>/index.js"
}

class RegistryGenerator {
  constructor(options?: Partial<RegistryGeneratorOptions>);
  generate(contexts: readonly ContextMessages[]): string;
}
```

`generate()` sorts contexts by name and, within each context, events, commands and queries by name, and registers them in that order. Without any message it returns an empty registry. Contexts without messages get no import.

The CLI uses namespace mode (`useNamespace: true`) and computes each `importPath` relative to the output directory:

```typescript
import { MessageRegistry } from "@hexaijs/plugin-contracts-generator/runtime";
import * as orders from "./orders/index.js";
import * as videoLesson from "./video-lesson/index.js";

export * as orders from "./orders/index.js";
export * as videoLesson from "./video-lesson/index.js";

export const messageRegistry = new MessageRegistry()
    .register(orders.OrderPlaced)
    .register(orders.PlaceOrderCommand)
    .register(videoLesson.VideoLessonStarted);
```

Namespace names are context names converted from kebab-case to camelCase. Namespaces keep same-named classes from different contexts apart. Direct mode (the class default) imports message names directly and fails to compile when two contexts share a class name:

```typescript
import { MessageRegistry } from "@hexaijs/plugin-contracts-generator/runtime";
import { OrderPlaced, PlaceOrderCommand } from "./orders/index.js";

export const messageRegistry = new MessageRegistry()
    .register(OrderPlaced)
    .register(PlaceOrderCommand);
```

### Runtime (`src/runtime/message-registry.ts`)

The runtime entry imports nothing from the rest of the package, so generated code can load it without loading the TypeScript compiler.

```typescript
type Version = string | number | undefined;

interface MessageHeaders {
  id: string;
  type: string;
  schemaVersion?: Version;
  createdAt: Date;
  [key: string]: unknown;
}

interface MessageClass<T = any> {
  getSchemaVersion(): Version;
  getType(): string;
  from(rawPayload: Record<string, unknown>, header?: MessageHeaders): T;
  new (payload: any, options?: any): T;
}

class MessageRegistry {
  register(messageClass: MessageClass): this;
  dehydrate<T>(header: MessageHeaders, body: Record<string, unknown>): T;
  has(type: string, version?: Version): boolean;
  size(): number;
}
```

The registry key is `type` or `type:version`. `register()` throws on a duplicate key; `dehydrate()` throws for an unknown key and otherwise returns `messageClass.from(body, header)`. `runtime/index.ts` exports `MessageRegistry`, `MessageClass` and `MessageHeaders`; `Version` stays internal.

## 13. Re-export generation

`src/reexport-generator.ts` writes the bridge files for `pathAliasRewrites` (see the [README](../README.md#path-alias-rewrites)).

```typescript
interface RewrittenImport {
  readonly rewrittenPath: string;   // "@acme/contracts/shared/money"
  readonly originalPath: string;    // "@acme/shared/money"
  readonly symbols: readonly string[];
  readonly isTypeOnly: boolean;
}

interface ReexportFile {
  readonly relativePath: string;    // "shared/money.ts"
  readonly originalModule: string;  // "@acme/shared/money"
  readonly symbols: readonly string[];
  readonly isTypeOnly: boolean;
}

class ReexportGenerator {
  constructor(options?: { fileSystem?: FileSystem });
  analyze(options: { files: readonly string[]; pathAliasRewrites: ReadonlyMap<string, string> }): Promise<ReexportFile[]>;
  generate(options: { outputDir: string; reexportFiles: readonly ReexportFile[] }): Promise<string[]>;
}
```

`analyze()` reads the copied files and finds import declarations whose specifier starts with a rewritten prefix. It maps each back to the original module, groups imports by rewritten specifier and merges their symbols. A group is type-only when every import in it is. The file path is the specifier without its package name (one segment, or two for a scoped package) plus `.ts`, or `index.ts` when nothing remains.

`generate()` writes `export { A, B } from "<original>";` (or `export type { ... }`) to `<outputDir>/<relativePath>`. A default import is re-exported as a named symbol of the same name, which is only correct when the original module has a named export of that name.

## 14. Infrastructure

### File system (`src/file-system.ts`)

```typescript
interface FileStats {
  isDirectory(): boolean;
  isFile(): boolean;
}

interface FileSystem {
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStats>;
}

class NodeFileSystem implements FileSystem { /* fs/promises, UTF-8 */ }
const nodeFileSystem: FileSystem;
```

Every stage takes a `FileSystem`, so unit tests run against the in-memory implementation in `test-utils.ts`. Two places bypass it: `Scanner.scan()` lists files with `glob` on the real disk, and the CLI's `--check` comparison and temporary directories use `node:fs/promises` directly.

### Logger (`src/logger.ts`)

```typescript
type LogLevel = "debug" | "info" | "warn" | "error";

interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

class ConsoleLogger implements Logger {
  constructor(options?: { level?: LogLevel });   // default "info"
}

const noopLogger: Logger;
```

The CLI and the plugin log at `info`. Library entry points default to `noopLogger`.

### Errors (`src/errors.ts`)

```text
MessageParserError
├── ConfigurationError
│   └── ConfigLoadError
├── BoundaryViolationError
├── UnsafeDependencySliceError        filePath, reason
├── FileSystemError                   path
│   ├── FileNotFoundError
│   ├── FileReadError
│   └── FileWriteError
├── ParseError
│   └── JsonParseError                filePath?
└── ResolutionError
    └── ModuleResolutionError         moduleSpecifier, fromFile
```

| Thrown by | Error |
|-----------|-------|
| `ConfigLoader`, the `validate*()` functions | `ConfigLoadError` |
| `processContext()`, `ContractsPipeline.create()`, `FileCopier.copyFiles()` | `ConfigurationError` (removed `entryStrategy`, invalid `dependencyStrategy`) |
| `FileCopier` | `BoundaryViolationError`, `UnsafeDependencySliceError`, `FileReadError`, `FileWriteError` |
| `DependencySymbolSlicer` | `UnsafeDependencySliceError` |
| `Scanner`, `FileGraphResolver` | `FileReadError` |

`FileNotFoundError`, `ParseError`, `JsonParseError`, `ResolutionError` and `ModuleResolutionError` are exported but not thrown. A plain `Error` comes from `parseArgs()` (see [Standalone CLI](#standalone-cli-srcclits)), `--check` failures, tsconfig parse failures, `ContextConfig.create()` input checks and the plugin's `entryStrategy` check.

### Helper modules

| Module | Used exports |
|--------|--------------|
| `ast-utils.ts` | `parseTypeNode()`, `extractFieldsFromMembers()`, `isPrimitiveTypeName()` |
| `import-analyzer.ts` | `extractImportBindings()` (binding per local name, with import kind and type-only flag), `extractImports()` (`ClassImport` list for the parser), `extractImportedNames()`, `isExternalModule()` |
| `class-analyzer.ts` | `extractClassSourceText()`, `getBaseClassName()`, `hasExportModifier()` |

`class-analyzer.ts` also exports `hasDecorator()`, `hasLeadingCommentMarker()`, `getDecoratorOptions()` and `collectClassReferences()`, which nothing calls; marker detection lives in `ContractDecoratorMatcher`.

## 15. Module dependencies

Arrows point from a module to the modules it imports. Every module may also import `domain/`, `errors`, `file-system` and `logger`.

```text
index ──► pipeline, config-loader, context-config, scanner, parser, file-graph-resolver,
          file-copier, registry-generator, reexport-generator, hexai-plugin

hexai-plugin ──► cli, config-loader
cli ──► index, config-loader, context-config, registry-generator, reexport-generator,
        module-specifier

pipeline ──► scanner, parser, contract-selector, file-graph-resolver, file-copier,
             context-config

scanner ──► contract-decorator-matcher
parser ──► contract-decorator-matcher, ast-utils, class-analyzer, import-analyzer
contract-decorator-matcher ──► import-analyzer
file-graph-resolver ──► context-config, import-analyzer
file-copier ──► contract-decorator-matcher, contract-selector, dependency-symbol-slicer,
                file-graph-resolver (types), import-analyzer, module-specifier
dependency-symbol-slicer ──► import-analyzer, file-graph-resolver (types)
registry-generator ──► module-specifier
config-loader ──► context-config
class-analyzer ──► ast-utils

runtime/message-registry ──► nothing
```

## 16. Tests

Run the suite from the package directory with `pnpm test` (`vitest run`).

| Location | Covers |
|----------|--------|
| `src/*.test.ts` | One file per module, mostly against the in-memory file system from `test-utils.ts`. |
| `e2e/generation/` | Full generation runs over the fixtures in `e2e/fixtures/`. About half also compile the output with TypeScript, some with NodeNext resolution. |
| `e2e/cli/` | `run()` and `runWithConfig()` with real config files, including `outputs[]`, globs and flag parsing. |
| `e2e/runtime/` | Imports generated modules and runs them: constructs messages and calls their methods. |
| `e2e/helpers/` | `E2ETestContext`, file and compile assertions, runtime import helpers. |
| `test/fixtures/` | Sample projects and configs for unit tests. |

A change to marker matching, selection or copying usually needs a unit test next to the module and a fixture-based case in `e2e/generation/`.
