# Architecture

This document defines the module structure and interfaces for the Contracts Generator.

> **Related Documentation**
> - [DOMAIN-MODEL.md](./DOMAIN-MODEL.md): Core domain model definitions

## Directory Structure

```
src/
├── index.ts              # Main entry point (processContext, exports)
├── cli.ts                # Command-line interface
├── hexai-plugin.ts       # hexai CLI plugin integration
├── errors.ts             # Domain error classes (hierarchical error types)
├── domain/               # Core type definitions
│   ├── types.ts
│   └── index.ts
│
├── # Infrastructure
├── file-system.ts        # FileSystem abstraction interface
├── logger.ts             # Logger interface and ConsoleLogger
├── pipeline.ts           # ContractsPipeline orchestrator
│
├── # Core Modules
├── scanner.ts            # Find public contract entry files
├── parser.ts             # Extract messages and public contract metadata from AST
├── contract-decorator-matcher.ts # Source-aware Contract/Public marker matching
├── contract-selector.ts  # Output-level visibility/kind/tag selection
├── ast-utils.ts          # Low-level AST manipulation
├── import-analyzer.ts    # Import statement analysis
├── class-analyzer.ts     # Class declaration analysis
├── file-graph-resolver.ts # Build import dependency graph
├── file-copier.ts        # Copy files with import rewriting
├── config-loader.ts      # Load application.config.ts
├── context-config.ts     # Context configuration with tsconfig path alias resolution
├── registry-generator.ts # Generate MessageRegistry registration code
├── reexport-generator.ts # Generate re-export files for path alias rewrites
├── test-utils.ts         # Test utilities
│
└── runtime/              # Runtime utilities (used by contracts package)
    ├── index.ts
    └── message-registry.ts  # Message class registry for deserialization
```

## Module Overview

### Pipeline Boundaries

The generator keeps discovery, semantic selection, strategy choice, and emission separate:

1. **Scan** (`Scanner`): find candidate entry files by text markers. `messageTypes` narrows message decorator patterns; `includePublicContracts` controls general contract marker discovery.
2. **Parse** (`Parser`): validate AST shapes and extract message metadata, response type definitions, and general contract metadata through `ContractDecoratorMatcher`.
3. **Selection** (`ContractsPipeline`, `contract-selector.ts`): choose selected messages and selected general contracts by `visibility`, `kind`, `messageKinds`, `include`, and `tags`. Under the opt-in `entryStrategy: "graph"`, those selections become graph root files; filters limit only graph roots and later `MessageRegistry` entries.
4. **EntryStrategy** (`FileCopier`): `symbols` is the default and performs strict extraction of selected entry declarations, import-shape-aware filtering, and minimal local dependency expansion. `graph` copies selected entry files and their dependency graphs when explicitly requested.
5. **Emit** (`FileCopier`, barrel export, optional `RegistryGenerator`): write copied/extracted files, remove markers when configured, add missing `export` modifiers for selected response/public contract declarations, generate context barrels, and optionally generate a registry for selected messages only.

### 1. Contract Markers

Contract decorators live in the `@hexaijs/contracts` package (`@hexaijs/contracts/decorators`). They are pure no-op class decorators used as markers for static analysis. No `reflect-metadata` dependency.

```typescript
// @hexaijs/contracts/decorators
@ContractEvent(options?: ContractEventOptions)     // { version?, context?, visibility?, tags? }
@ContractCommand(options?: ContractCommandOptions) // { context?, response?, visibility?, tags? }
@ContractQuery(options?: ContractQueryOptions)     // { context?, response?, visibility?, tags? }
@Contract(options?: ContractOptions)               // { kind?, context?, response?, version?, visibility?, tags? }
```

`kind` is the contract role/discriminator. Built-in message kinds are `event`, `command`, and `query`. A generic `@Contract({ kind: "command" })` is treated as a message command. Custom kinds such as `read-model`, `value-object`, `dto`, or `snapshot` are general contracts.

`visibility` is the public/internal boundary used by output selection. It defaults to `"public"`. `tags` are auxiliary labels for secondary filters and must not be treated as the public/internal boundary.

Legacy decorators are deprecated aliases and still work without runtime warnings:

```typescript
@PublicEvent()
@PublicCommand()
@PublicQuery()
@PublicContract()
```

General contracts use `@Contract({ kind: "contract" })` or a custom `kind`. Classes support the no-op runtime decorator form:

```typescript
@Contract({ kind: "snapshot" })
export class PublicOrderSnapshot {
  constructor(public readonly orderId: string) {}
}
```

Interfaces, type aliases, and enums cannot use TypeScript decorators, so they use leading TypeScript comment markers:

```typescript
// @Contract({ kind: "snapshot", visibility: "public", tags: ["frontend"] })
interface PublicOrderSnapshot {
  orderId: string;
}

/* @Contract({ kind: "value-object" }) */
enum PublicOrderChannel {
  Online = "online",
  Store = "store",
}

/** @Contract({ kind: "read-model", visibility: "internal", tags: ["admin"] }) */
type PublicOrderStatus = "draft" | "placed";
```

The comment marker applies to the following declaration only when it appears in the declaration's leading comments. Line comments, block comments, and JSDoc comments are supported for `class`, `interface`, `type`, and `enum`.

The Scanner finds files containing contract decorator patterns or contract comment marker text via text search. The Parser then validates the AST shape and extracts message metadata or general contract metadata.

#### 1.1 Import and Source Matching

`ContractDecoratorMatcher` is the authoritative marker interpreter for parser and copier behavior.

Supported decorator forms:

- Direct named imports from `@hexaijs/contracts` and `@hexaijs/contracts/decorators`
- Direct named imports from configured `trustedDecoratorSources`
- Named import aliases, for example `import { ContractCommand as InternalCommand } from "@hexaijs/contracts/decorators"`
- Generic `Contract` aliases with `kind`
- Legacy `Public*` names
- Comment markers without any import

Unbound canonical `Contract*` decorator names are ignored unless they are explicitly configured as legacy/custom `decoratorNames` or `contractMarkerNames`. Same-named decorators from untrusted packages are ignored. Type-only imports are ignored. Namespace decorator imports, such as `Contracts.ContractCommand`, are not supported in this release.

Local re-export chains are intentionally not traced automatically. A local barrel can be used only when the integration adds that source to `trustedDecoratorSources`; otherwise import decorators directly from the canonical packages. Comment markers remain import-free and are the safest option for interface/type/enum declarations.

---

### 2. Scanner (`src/scanner.ts`)

Finds files containing contract entry markers in the source directory. Entry markers include message decorators (`@ContractEvent`, `@ContractCommand`, `@ContractQuery`), generic `@Contract({ kind })`, legacy `Public*` decorators, and comment-based general contract markers.

```typescript
interface ScannerOptions {
  exclude?: string[];  // Exclude glob patterns
  decoratorNames?: DecoratorNames
  contractMarkerNames?: ContractMarkerNames
  messageTypes?: MessageType[]
  includePublicContracts?: boolean
}

class Scanner {
  constructor(options?: ScannerOptions)
  async scan(sourceDir: string): Promise<string[]>
}
```

**Default Exclusion Patterns**:
- `**/node_modules/**`
- `**/dist/**`
- `**/*.d.ts`
- `**/*.test.ts`
- `**/*.spec.ts`

**Algorithm**:
1. Traverse all TypeScript files using `**/*.ts` glob
2. Search file contents for canonical and configured message decorator text (`@ContractEvent(`, `@ContractCommand(`, `@ContractQuery(`, legacy configured names)
3. Search file contents for generic contract marker text (`@Contract`) and configured legacy public contract marker text (`@PublicContract` by default) when public contracts are included
4. Return matching file paths

**Characteristics**: Optimizes performance with fast text matching before AST parsing. Text matching is intentionally broad; the Parser is responsible for enforcing source-aware decorator matching and declaration-leading comment markers. When `messageTypes` is provided, general contract marker scanning is disabled by default unless `includePublicContracts` is set.

---

### 3. Parser (`src/parser.ts`)

Analyzes TypeScript AST to extract message class information and general contract metadata.

```typescript
interface ParseResult {
  readonly events: readonly DomainEvent[]
  readonly commands: readonly Command[]
  readonly queries: readonly Query[]
  readonly publicContracts: readonly PublicContract[]
  readonly typeDefinitions: readonly TypeDefinition[]
}

class Parser {
  parse(sourceCode: string, sourceFileInfo: SourceFile): ParseResult
}
```

**Extraction Process**:
1. Generate TypeScript AST
2. Traverse `ClassDeclaration`, `InterfaceDeclaration`, `TypeAliasDeclaration`, and `EnumDeclaration` nodes
3. For classes, check message decorators (`@ContractEvent`, `@ContractCommand`, `@ContractQuery`), generic `@Contract({ kind })`, and legacy `Public*` markers through `ContractDecoratorMatcher`
4. For classes, check generic/general `@Contract` decorators and configured leading comment markers
5. For interfaces, type aliases, and enums, check the configured leading comment marker only; no import is required
6. Extract message payload type (`extends Message<PayloadType>`)
7. Collect class imports and dependencies
8. Extract base class name
9. Record general contract metadata separately from the `Message` union

**Extracted Data**:
- `name`: Class name
- `fields`: Payload field list
- `payloadType`: Original type reference
- `sourceText`: Complete class source code
- `imports`: All import statements in the file
- `baseClass`: Inherited class name

**General Contract Data**:
- `name`: Declaration name
- `contractType`: Always `"contract"`
- `declarationKind`: `"class"`, `"interface"`, `"type"`, or `"enum"`
- `sourceFile`: Original source file
- `exported`: Whether the source declaration was exported. Unexported public contracts are exported in generated output.

Public contracts are included in generated contracts output, but they are not message contracts and are not registered in `MessageRegistry`; only selected decorated messages are registered.

---

### 4. TypeScript Utilities (Separated Modules)

TypeScript Compiler API functionality is separated by concern.

#### 4.1 AST Utils (`src/ast-utils.ts`)

Low-level AST manipulation functions:

```typescript
// Type Parsing
parseTypeNode(typeNode: ts.TypeNode): TypeRef

// Field Extraction
extractFieldsFromMembers(members: ts.NodeArray<ts.TypeElement>): Field[]

// Helper
isPrimitiveTypeName(name: string): boolean
```

#### 4.2 Import Analyzer (`src/import-analyzer.ts`)

Import analysis functions:

```typescript
isExternalModule(moduleSpecifier: string): boolean
extractAllImports(sourceFile: ts.SourceFile): ClassImport[]
extractClassImports(sourceFile: ts.SourceFile, neededRefs: Set<string>): ClassImport[]
extractImportedNames(importClause: ts.ImportClause): string[]
```

#### 4.3 Class Analyzer (`src/class-analyzer.ts`)

Class analysis functions:

```typescript
hasDecorator(node: ts.ClassDeclaration, decoratorName: string): boolean
hasLeadingCommentMarker(node: ts.Node, sourceCode: string, markerName: string): boolean
hasExportModifier(node: ts.Node): boolean
extractClassSourceText(node: ts.ClassDeclaration, sourceCode: string): string
getBaseClassName(node: ts.ClassDeclaration): string | undefined
collectClassReferences(node: ts.ClassDeclaration): Set<string>
```

---

### 5. File Graph Resolver (`src/file-graph-resolver.ts`)

Builds an import dependency graph from entry point files.

```typescript
interface FileGraphResolverOptions {
  tsconfigPath?: string              // Path to tsconfig.json
  pathAliasConfig?: PathAliasConfig  // Pre-loaded path alias config
  excludeDependencies?: string[]     // Glob patterns for dependencies to exclude
}

interface ImportInfo {
  moduleSpecifier: string     // Import path (e.g., './foo', '@alias/bar')
  resolvedPath: string | null // Resolved absolute path
  isExternal: boolean         // External package flag
  importedNames: string[]     // Imported identifiers
}

interface FileNode {
  absolutePath: string
  relativePath: string
  imports: ImportInfo[]
  isEntryPoint: boolean
}

interface FileGraph {
  nodes: Map<string, FileNode>
  entryPoints: Set<string>
  excludedPaths: Set<string>  // Excluded file paths (used for import removal)
}

class FileGraphResolver {
  constructor(options?: FileGraphResolverOptions)
  buildGraph(entryPoints: string[], sourceRoot: string): FileGraph
}
```

**Path Resolution Support**:
- Relative paths: `./foo`, `../bar`
- Path aliases: `@core/*` → `src/core/*` (based on tsconfig.json)
- External packages: `lodash`, `@hexaijs/core`

**Dependency Exclusion**:
- Specify files to exclude during dependency traversal via `excludeDependencies` glob patterns
- Excluded file paths are collected in `FileGraph.excludedPaths`
- Default exclusion patterns: `**/*.test.ts`, `**/*.spec.ts`, `**/*.eh.ts`, `**/db.ts`, `**/infra/**`

**Algorithm**: BFS traversal for dependency graph exploration

---

### 6. File Copier (`src/file-copier.ts`)

Handles Entry files and Dependency files differently.

```typescript
interface CopyOptions {
  sourceRoot: string
  outputDir: string
  fileGraph: FileGraph
  pathAliasRewrites?: Map<string, string>  // e.g., Map([['@libera/', '@/']])
  removeDecorators?: boolean               // Remove message decorators from generated output
  messageTypes?: MessageType[]             // Message types to extract ('event' | 'command' | 'query')
  entryStrategy?: EntryStrategy            // 'symbols' default, or 'graph' for entry file graph copying
  decoratorNames?: DecoratorNames          // Decorator names for each messageType
  contractMarkerNames?: ContractMarkerNames // Comment marker names for general contracts
  includePublicContracts?: boolean          // Include marked general contracts
  select?: ContractOutputSelect             // Output-level visibility/kind/tag/category filter
  responseTypesToInclude?: Map<string, string[]> // Response type declarations to include in symbols output
  responseTypesToExport?: Map<string, string[]>  // Unexported response types to export
  publicContractsToExport?: Map<string, string[]> // Unexported public contracts to export
}

interface CopyResult {
  copiedFiles: string[]
  rewrittenImports: Map<string, string[]>
}

class FileCopier {
  async copyFiles(options: CopyOptions): Promise<CopyResult>
  generateBarrelExport(copiedFiles: string[]): string
}
```

**Entry vs Dependency File Processing**:

| File Type | Processing Method | Reason |
|-----------|-------------------|--------|
| **Selected entry files with `graph` strategy** | Full module copy + dependency graph copy | Preserve runtime validation/domain dependencies for generated contracts |
| **Filtered entry files with `graph` strategy** | Root selection + full copy of selected entry files | Message/output filters select graph roots and registry entries only; selected files can still include other declarations and trigger a warning |
| **Entry files with `symbols` strategy** | Symbol extraction + import filtering | Strictly include selected message types and marked general contract declarations |
| **Dependency files** | Full module copy | Simplification, automatic barrel file support |

**Entry File Symbol Extraction (`extractSymbolsFromEntry()`)**:
1. Extract message classes matching `messageTypes`
2. Extract general contract classes marked by decorator or comment
3. Extract general contract interfaces, type aliases, and enums marked by comment only
4. Track local type dependencies used by extracted declarations
5. Include same-file command/query response types discovered by explicit decorator options or naming conventions
6. Expand used identifiers from selected declarations through local declaration dependencies in the same entry file
7. Filter and keep only used imports

**Import Rewriting**:
1. Internal path alias → relative path conversion (e.g., `@core/types` → `./types`)
2. External path alias → specified prefix conversion (e.g., `@libera/common` → `@/common`)

**Symbols import-shape support**:
- Retains default imports used by selected entry declarations.
- Retains namespace imports used through qualified references, including nested references such as `Types.Inner.User`.
- Retains named import aliases such as `import { User as DomainUser } from "./user"`.
- Retains mixed default + named imports and removes unused named specifiers when the import can be safely rewritten.
- Retains type-only default imports.
- Preserves already-exported local function dependencies without adding a duplicate `export`.

This is direct AST expansion for selected entry files. It is not TypeChecker-based semantic slicing. Local dependency files reached through retained imports are copied as whole files through the FileGraph; they are not sliced down to individual symbols. With strict output selectors, copying fails fast with `BoundaryViolationError` if a copied file contains a marked declaration outside the selection. Keep shared DTO/value-object dependencies boundary-clean and separate from internal implementation modules.

**Additional Features**:
- **Excluded file import removal**: Automatically removes import/export statements referencing files in `FileGraph.excludedPaths`
- **Decorator removal**: Removes matched contract decorators (`@ContractCommand`, `@ContractEvent`, `@ContractQuery`, `@Contract`, and legacy configured names) and related imports when `removeDecorators: true`
- **Trusted decorator barrel pruning**: Skips trusted decorator-only local barrels from generated output when `removeDecorators: true`
- **Boundary guard**: Throws `BoundaryViolationError` for strict output selectors before copying marked declarations outside the selected surface
- **Public contract output**: Includes marked `class`, `interface`, `type`, and `enum` declarations in generated contracts output without adding them to `MessageRegistry`
- **Missing export repair**: Adds `export` to selected response types and selected public contracts when the source declaration is not exported
- **Transitive dependency tracking**: Includes dependencies of dependencies via FileGraph-based BFS, not just direct imports from entry files

**Known limitation**: `graph` strategy may copy unselected declarations from selected entry files because the whole selected file is copied. The pipeline emits a warning when `graph` is combined with strict output selection. Use `symbols` for strict public/internal output splits.

---

### 7. Context Config (`src/context-config.ts`)

Encapsulates context configuration with path resolution capabilities. Created via factory method to ensure proper initialization.

```typescript
interface InputContextConfig {
  readonly name: string             // Context name (e.g., 'lecture')
  readonly path: string             // Base path to context (e.g., 'packages/lecture')
  readonly sourceDir?: string       // Source subdirectory (default: 'src')
  readonly tsconfigPath?: string    // TypeScript config (default: 'tsconfig.json', auto-detected)
}

class ContextConfig {
  readonly name: string
  readonly sourceDir: string        // Absolute path

  static async create(input: InputContextConfig, configDir: string): Promise<ContextConfig>
  async resolvePath(moduleSpecifier: string): Promise<{ resolvedPath: string | null; isExternal: boolean }>
}
```

**Features**:
- Factory method with async initialization (`create()`)
- Path alias resolution via tsconfig.json (recursive `extends` support)
- Module specifier resolution (relative, alias, external)
- Convention over Configuration defaults (`src/`, `tsconfig.json`)

---

### 8. Config Loader (`src/config-loader.ts`)

Loads contracts configuration from `application.config.ts`.

```typescript
// Input interface for user configuration
interface InputContextConfig {
  readonly name: string             // Context name (e.g., 'lecture')
  readonly path: string             // Base path to context (e.g., 'packages/lecture')
  readonly sourceDir?: string       // Source subdirectory (default: 'src')
  readonly tsconfigPath?: string    // TypeScript config (default: 'tsconfig.json', auto-detected)
}

// Class with path resolution capabilities (created via factory method)
class ContextConfig {
  readonly name: string
  readonly sourceDir: string        // Absolute path

  static async create(input: InputContextConfig, configDir: string): Promise<ContextConfig>
  async resolvePath(moduleSpecifier: string): Promise<{ resolvedPath: string | null; isExternal: boolean }>
}

interface ContractsConfig {
  readonly contexts: readonly ContextConfig[]
  readonly outputs?: readonly ContractOutputConfig[]
  readonly pathAliasRewrites?: Readonly<Record<string, string>>
  readonly externalDependencies?: Readonly<Record<string, string>>
  readonly decoratorNames: Required<DecoratorNames>
  readonly contractMarkerNames: Required<ContractMarkerNames>
  readonly trustedDecoratorSources?: readonly string[]
  readonly entryStrategy?: EntryStrategy
  readonly responseNamingConventions?: readonly ResponseNamingConvention[]
  readonly removeDecorators?: boolean
}

interface ContractOutputConfig {
  readonly name: string
  readonly path: string
  readonly select?: ContractOutputSelect
  readonly registry?: boolean
}

interface ContractOutputSelect {
  readonly visibility?: readonly ('public' | 'internal')[]
  readonly kinds?: readonly string[]
  readonly messageKinds?: readonly ('command' | 'query' | 'event')[]
  readonly include?: 'all' | 'messages' | 'contracts'
  readonly tags?: {
    readonly include?: readonly string[]
    readonly exclude?: readonly string[]
  }
}

class ConfigLoader {
  async load(configPath: string): Promise<ContractsConfig>
}

class ConfigLoadError extends Error {
  constructor(message: string)
}
```

**Context Resolution** (Convention over Configuration):
- String path: `'packages/lecture'` → name = 'lecture', sourceDir = 'src', tsconfig auto-detected
- Glob pattern: `'packages/*'` → Each directory resolved with same defaults
- Object: `{ name, path, sourceDir?, tsconfigPath? }` → Explicit configuration with optional overrides

**Output Resolution**:
- If `contracts.outputs` is absent, CLI single-output mode requires `--output-dir`.
- If `contracts.outputs` is present, each output path is resolved relative to the config file.
- `--output-dir` is rejected when `contracts.outputs` is configured.
- The hexai plugin marks `-o, --output-dir` optional because it is required only for legacy single-output config without `outputs[]`; omit it when `outputs[]` is configured.
- `outputs[].registry: true` generates a registry for that output; `--registry` enables registry generation for every configured output.
- `select.visibility` is the primary boundary for public/internal output separation. `select.tags` is auxiliary filtering only.

---

### 9. CLI (`src/cli.ts`)

Command-line interface and full pipeline orchestration.

```bash
Usage: generate-contracts [options]

Options:
  -o, --output-dir <path>               Output directory for generated contracts; required unless contracts.outputs is configured
  -c, --config <path>                   Path to config file (default: application.config.ts)
  --include <all|messages|contracts>    Contract categories to generate (default: all)
  --messages <event,command,query>      Message subtype filter (default: event,command,query)
  -m, --message-types <types>           Legacy alias for --messages
  --entry-strategy <graph|symbols>      Entry strategy (default: symbols)
  --registry                            Generate MessageRegistry export
  --generate-message-registry           Legacy verbose alias for --registry
  --dry-run                             Print plan/summary without writing files
  --check                               Verify generated output freshness for CI
  -h, --help                            Show this help message
```

The default scope is `--include all` with `--entry-strategy symbols`, which emits selected decorated public messages and marked general contract declarations as a strict public contract surface. `--include messages` selects only decorated message contracts. `--include contracts` selects only general contract declarations. The `--messages` filter applies only to message subtypes and does not filter general contracts. Use `--entry-strategy graph` when conservative entry file graph copying is required. Under `graph`, filters select graph roots and registry entries only, and the pipeline logs a warning because selected entry files can still be copied whole with other declarations from the same file. Registry generation includes selected decorated messages only.

**Programmatic API**:
```typescript
async function run(args: string[]): Promise<void>
```

**Processing Flow**:
1. Load config
2. Resolve CLI generation scope from `--include` and `--messages`
3. Normalize either a single `--output-dir` plan or configured `contracts.outputs[]` plans
4. Run `ContractsPipeline` for each context and output plan, using a temporary output directory when `--check` or `--dry-run` is active
5. Output results (events, commands, queries, public contracts, files count) or dry-run/check summary

---

### 10. hexai Plugin (`src/hexai-plugin.ts`)

CLI plugin definition for integration with the hexai CLI tool.

```typescript
export const cliPlugin: HexaiCliPlugin<ContractsPluginConfig> = {
  name: "generate-contracts",
  description: "Extract public messages and contracts from bounded contexts",
  options: [
    { flags: "-o, --output-dir <path>", description: "Output directory", required: false },
    { flags: "--include <scope>", description: "Generate all, messages, or contracts" },
    { flags: "--messages <types>", description: "Filter message subtypes" },
    { flags: "-m, --message-types <types>", description: "Legacy alias for --messages" },
    { flags: "--entry-strategy <strategy>", description: "Entry strategy: graph or symbols" },
    { flags: "--registry", description: "Generate message registry" },
    { flags: "--generate-message-registry", description: "Legacy verbose alias for --registry" },
    { flags: "--dry-run", description: "Print plan without writing files" },
    { flags: "--check", description: "Verify generated output freshness" },
  ],
  run: async (args, config) => { ... }
}
```

**Usage**:
```bash
pnpm hexai generate-contracts -o packages/contracts/src
pnpm hexai generate-contracts -o packages/contracts/src --dry-run
pnpm hexai generate-contracts -o packages/contracts/src --registry
pnpm hexai generate-contracts -o packages/contracts/src --include messages --messages event,command
pnpm hexai generate-contracts -o packages/contracts/src --include contracts
pnpm hexai generate-contracts -o packages/contracts/src --entry-strategy symbols
pnpm hexai generate-contracts -o packages/contracts/src --check
```

---

### 11. Main Entry Point (`src/index.ts`)

Provides the programmatic API.

```typescript
interface ProcessContextOptions {
  contextName: string
  path: string
  sourceDir?: string
  outputDir: string
  pathAliasRewrites?: Map<string, string>
  tsconfigPath?: string
  decoratorNames?: DecoratorNames
  contractMarkerNames?: ContractMarkerNames
  trustedDecoratorSources?: readonly string[]
  fileSystem?: FileSystem           // File system abstraction (default: nodeFileSystem)
  logger?: Logger                   // Logger instance (default: noopLogger)
  messageTypes?: MessageType[]      // Message types to extract ('event' | 'command' | 'query')
  includePublicContracts?: boolean  // Include marked general contracts
  entryStrategy?: EntryStrategy     // 'symbols' default, or 'graph' for entry file graph copying
  removeDecorators?: boolean        // Remove message decorators from output
  responseNamingConventions?: readonly ResponseNamingConvention[]  // Patterns for matching response types
}

interface ProcessContextResult {
  events: DomainEvent[]
  commands: Command[]
  queries: Query[]
  publicContracts: PublicContract[]
  copiedFiles: string[]
}

async function processContext(options: ProcessContextOptions): Promise<ProcessContextResult>
```

**Internal Implementation**: Creates and executes `ContractsPipeline`

---

### 12. FileSystem Abstraction (`src/file-system.ts`)

Abstracts file system access for testability and flexibility.

```typescript
interface FileStats {
  isDirectory(): boolean
  isFile(): boolean
}

interface FileSystem {
  readFile(path: string): Promise<string>
  readdir(path: string): Promise<string[]>
  writeFile(path: string, content: string): Promise<void>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<FileStats>
}

class NodeFileSystem implements FileSystem { ... }

// Singleton instance
const nodeFileSystem: FileSystem
```

**Purpose**:
- Enable unit testing without actual file system via mocks
- Unified async I/O
- Future support for other environments (memory, remote, etc.)

---

### 13. Logger Infrastructure (`src/logger.ts`)

Provides a configurable logging interface.

```typescript
type LogLevel = "debug" | "info" | "warn" | "error"

interface Logger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

interface ConsoleLoggerOptions {
  level?: LogLevel  // Default: "info"
}

class ConsoleLogger implements Logger {
  constructor(options?: ConsoleLoggerOptions)
}

// No-op singleton (for testing/library usage)
const noopLogger: Logger
```

**Logging Points**:
| Stage | Level | Content |
|-------|-------|---------|
| execute | info | Context processing start/complete |
| scan | debug | Scan start, discovered file count |
| parse | debug | Parse start, extracted events, commands, queries, and public contracts count |
| resolve | debug | Dependency resolution start, graph node count |
| select/copy | debug | Output selection, copy start, copied file count |

---

### 14. ContractsPipeline Orchestrator (`src/pipeline.ts`)

Orchestrator class encapsulating the entire extraction pipeline.

```typescript
interface PipelineDependencies {
  readonly scanner: Scanner
  readonly parser: Parser
  readonly fileGraphResolver: FileGraphResolver
  readonly fileCopier: FileCopier
  readonly fileSystem: FileSystem
  readonly logger: Logger
}

interface PipelineOptions {
  readonly contextName: string
  readonly sourceDir: string
  readonly outputDir: string
  readonly pathAliasRewrites?: Map<string, string>
  readonly select?: ContractOutputSelect
  readonly removeDecorators?: boolean
}

interface PipelineResult {
  readonly events: DomainEvent[]
  readonly commands: Command[]
  readonly queries: Query[]
  readonly publicContracts: PublicContract[]
  readonly copiedFiles: string[]
}

interface ParsedMessages {
  readonly events: DomainEvent[]
  readonly commands: Command[]
  readonly queries: Query[]
  readonly publicContracts: PublicContract[]
  readonly typeDefinitions: TypeDefinition[]
}

class ContractsPipeline {
  // Factory method (auto-configure dependencies)
  static create(options: {
    contextConfig: ContextConfig
    decoratorNames?: DecoratorNames
    contractMarkerNames?: ContractMarkerNames
    trustedDecoratorSources?: readonly string[]
    messageTypes?: MessageType[]
    includePublicContracts?: boolean
    entryStrategy?: EntryStrategy
    responseNamingConventions?: readonly ResponseNamingConvention[]
    fileSystem?: FileSystem
    logger?: Logger
  }): ContractsPipeline

  // Test factory (direct dependency injection)
  static fromDependencies(deps: PipelineDependencies): ContractsPipeline

  // Execute full pipeline
  async execute(options: PipelineOptions): Promise<PipelineResult>

  // Step-by-step methods (for testing)
  async scan(sourceDir: string): Promise<string[]>
  async parse(files: string[], sourceRoot: string): Promise<ParsedMessages>
  async resolve(entryPoints: string[], sourceRoot: string): Promise<FileGraph>
  async copy(
    fileGraph: FileGraph,
    sourceRoot: string,
    outputDir: string,
    pathAliasRewrites?: Map<string, string>,
    responseTypesToExport?: Map<string, string[]>,
    publicContractsToExport?: Map<string, string[]>,
    responseTypesToInclude?: Map<string, string[]>,
    removeDecorators?: boolean,
    messageTypes?: readonly MessageType[],
    entryStrategy?: EntryStrategy,
    select?: ContractOutputSelect
  ): Promise<string[]>
  async exportBarrel(copiedFiles: string[], outputDir: string): Promise<void>
}
```

**Benefits**:
- Testability through dependency injection
- Independent testing of each pipeline stage
- Clear separation of orchestration logic

---

### 15. Errors (`src/errors.ts`)

Provides a domain-specific error hierarchy.

```
MessageParserError (base)
├── ConfigurationError
│   └── ConfigLoadError
├── FileSystemError
│   ├── FileNotFoundError
│   ├── FileReadError
│   └── FileWriteError
├── ParseError
│   └── JsonParseError
└── ResolutionError
    └── ModuleResolutionError
```

**Error Handling Example**:
```typescript
import { MessageParserError, FileReadError } from '@hexaijs/plugin-contracts-generator';

try {
  await processContext(options);
} catch (error) {
  if (error instanceof FileReadError) {
    console.error(`Failed to read file: ${error.path}`);
    console.error(`Cause: ${error.cause}`);
  } else if (error instanceof MessageParserError) {
    console.error(`Parser error: ${error.message}`);
  }
}
```

---

### 16. MessageRegistry (`src/runtime/message-registry.ts`)

Runtime registry for registering and deserializing (dehydrating) message classes.

```typescript
type Version = string | number | undefined;

interface MessageHeaders {
  id: string
  type: string
  schemaVersion?: Version
  createdAt: Date
  [key: string]: unknown
}

interface MessageClass<T = unknown> {
  getSchemaVersion(): Version
  getType(): string
  from(rawPayload: Record<string, unknown>, header?: MessageHeaders): T
  new (...args: unknown[]): T
}

class MessageRegistry {
  register(messageClass: MessageClass): this
  dehydrate<T>(header: MessageHeaders, body: Record<string, unknown>): T
  has(type: string, version?: Version): boolean
  size(): number
}
```

**Usage Example**:
```typescript
import { MessageRegistry } from '@hexaijs/plugin-contracts-generator/runtime';
import { LectureCreated, VideoLessonStarted } from '@libera/contracts';

const registry = new MessageRegistry()
  .register(LectureCreated)
  .register(VideoLessonStarted);

// Deserialize message
const event = registry.dehydrate<LectureCreated>(header, body);
```

**Key Features**:
- Register classes by message type + version
- Convert raw payload to actual message instance
- Prevent duplicate registration (throws error)

---

### 17. RegistryGenerator (`src/registry-generator.ts`)

Automatically generates MessageRegistry registration code based on selected extracted message contracts. General contract declarations are intentionally excluded from registry generation.

```typescript
interface RegistryGeneratorOptions {
  readonly messageRegistryImport: string  // Default: "@hexaijs/plugin-contracts-generator/runtime"
  readonly useNamespace?: boolean         // Default: false, true enables namespace mode
}

interface ContextMessages {
  readonly contextName: string
  readonly events: readonly DomainEvent[]
  readonly commands: readonly Command[]
  readonly queries?: readonly Query[]
  readonly importPath?: string
}

class RegistryGenerator {
  constructor(options?: Partial<RegistryGeneratorOptions>)
  generate(contexts: readonly ContextMessages[]): string
}
```

**Namespace Mode** (`useNamespace: true`, used by the CLI-generated root registry):

```typescript
// contracts/src/index.ts
import { MessageRegistry } from "@hexaijs/plugin-contracts-generator/runtime";
import * as lecture from "./lecture";
import * as videoLesson from "./video-lesson";

export * as lecture from "./lecture";
export * as videoLesson from "./video-lesson";

export const messageRegistry = new MessageRegistry()
    .register(lecture.LectureCreated)
    .register(lecture.LectureExpanded)
    .register(videoLesson.VideoLessonStarted);
```

**Benefits**:
- **Name collision prevention**: Classes with the same name from different contexts are distinguished as `ctx.ClassName`
- **Explicit origin**: Code clearly shows which context each class belongs to
- **Type safety**: TypeScript recognizes each namespace as a separate module

**Default direct mode** (`useNamespace: false`, the `RegistryGenerator` constructor default):
```typescript
import { MessageRegistry } from "@hexaijs/plugin-contracts-generator/runtime";
import { LectureCreated, LectureExpanded } from "./lecture";
import { VideoLessonStarted } from "./video-lesson";

export const messageRegistry = new MessageRegistry()
    .register(LectureCreated)
    .register(LectureExpanded)
    .register(VideoLessonStarted);
```

**Note**: Direct mode can cause `Duplicate identifier` errors when classes with the same name exist in multiple contexts

**kebab-case → camelCase Conversion**:
- `video-lesson` → `videoLesson`
- `topic-generation` → `topicGeneration`

**Purpose**:
- Auto-generate MessageRegistry registration code for selected decorated events, commands, and queries in the contracts package's `index.ts`
- Enable message deserialization in frontend

---

### 18. ReexportGenerator (`src/reexport-generator.ts`)

Generates re-export files for imports rewritten via `pathAliasRewrites`.

```typescript
interface RewrittenImport {
  readonly rewrittenPath: string    // e.g., "@libera/contracts/common/request"
  readonly originalPath: string     // e.g., "@libera/common/request"
  readonly symbols: readonly string[]
  readonly isTypeOnly: boolean
}

interface ReexportFile {
  readonly relativePath: string     // e.g., "common/request.ts"
  readonly originalModule: string   // Original module to re-export from
  readonly symbols: readonly string[]
  readonly isTypeOnly: boolean
}

class ReexportGenerator {
  constructor(options?: { fileSystem?: FileSystem })

  // Analyze files to find imports matching pathAliasRewrites
  async analyze(options: {
    files: readonly string[]
    pathAliasRewrites: ReadonlyMap<string, string>
  }): Promise<ReexportFile[]>

  // Generate re-export files
  async generate(options: {
    outputDir: string
    reexportFiles: readonly ReexportFile[]
  }): Promise<string[]>
}
```

**Generated Output Example**:
```typescript
// common/request.ts
export { UseCaseRequest, BaseRequest } from "@libera/common/request";
```

**Purpose**:
- When `pathAliasRewrites` maps `@libera/common` → `@libera/contracts/common`
- Analyzes generated files to find imports using the rewritten paths
- Generates re-export files that bridge the rewritten paths to original modules

---

## Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     CLI / processContext()                                   │
│                                                                              │
│  ┌─ FileSystem ─┐  ┌─ Logger ─┐                                             │
│  │ nodeFileSystem│  │noopLogger│   (dependency injection)                    │
│  └──────────────┘  └──────────┘                                             │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│  ConfigLoader                                                                  │
│  ─────────────                                                                 │
│  application.config.ts → ContractsConfig                                       │
│  (contexts, pathAliasRewrites, decoratorNames, contractMarkerNames,             │
│   outputs/select, entryStrategy, ...)                                          │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │   For each context            │
                    └───────────────┬───────────────┘
                                    ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│  ContractsPipeline.execute()                                                   │
│  ───────────────────────────                                                   │
│  Pipeline orchestrator - coordinates each stage with logging                   │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│  1. SCAN (Scanner)                                                             │
│  ──────────────────                                                            │
│  Contract decorator discovery + general contract marker discovery              │
│  messageTypes filters only message decorators                                  │
│  Output: string[] (entry files)                                                │
└────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│  2. PARSE (Parser)                                                             │
│  ─────────────────                                                             │
│  Message class parsing + general contract metadata extraction                  │
│  Response matching by naming convention                                        │
│  Output: ParsedMessages (commands, events, queries, publicContracts, types)    │
└────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│  3. RESOLVE (FileGraphResolver)                                                │
│  ──────────────────────────────                                                │
│  Dependency file resolution + FileGraph creation (with isEntryPoint)          │
│  Output: FileGraph                                                             │
└────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│  4. ENTRY STRATEGY + EMIT (FileCopier)                                         │
│  ──────────────────────────────────────                                        │
│                                                                                │
│  Strategy choice                                                               │
│   - graph: copy selected entry files and dependency graphs                     │
│   - graph + filters: filters select roots and registry entries only            │
│   - symbols: explicit strict extraction of selected message and                │
│     general contract declarations                                              │
│                                                                                │
│  symbols-only dependency narrowing                                             │
│   - Expand selected entry declarations through direct AST references            │
│   - Preserve retained import shapes: default, namespace, aliases, mixed,        │
│     type-only default, and qualified namespace references                       │
│   - Recursively copy files reached through retained local imports via           │
│     FileGraph-based BFS                                                        │
│                                                                                │
│  Emit                                                                          │
│   - graph: copy full selected entry files and all resolved dependencies        │
│   - symbols: emit extracted entry declarations plus used dependency files       │
│   - Common post-processing: decorator removal, export repair, path aliases     │
│                                                                                │
│  Output: copiedFiles[]                                                         │
└────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│  5. BARREL                                                                     │
│  ─────────                                                                     │
│  Generate index.ts based on copiedFiles                                        │
│  (Based on actually copied files, not FileGraph)                               │
└────────────────────────────────────────────────────────────────────────────────┘
                                    │
                    └───────────────┴───────────────┘
                                    │
                                    ▼
                        ┌───────────────────────┐
                        │   Contracts Package   │
                        │   (ready to publish)  │
                        └───────────────────────┘
```

---

## Module Dependencies

```
                            ┌──────────────────┐
                            │   domain/types   │
                            │ (type definitions)│
                            └────────┬─────────┘
                                     │
     ┌──────────────────┐            │            ┌──────────────────┐
     │    FileSystem    │            │            │      Logger      │
     │  (file-system.ts)│            │            │   (logger.ts)    │
     └────────┬─────────┘            │            └────────┬─────────┘
              │                      │                     │
              └──────────────────────┼─────────────────────┘
                                     │
         ┌───────────────────────────┼───────────────────────────┐
         │                           │                           │
         ▼                           ▼                           ▼
  ┌─────────────┐      ┌───────────────────────┐        ┌───────────────┐
  │   Scanner   │      │   TS Utils (separated) │        │context-config │
  └─────────────┘      │ - ast-utils           │        └───────┬───────┘
                       │ - import-analyzer     │                │
                       │ - class-analyzer      │                │
                       └───────────┬───────────┘                │
                                   │                            │
         ┌─────────────────────────┼────────────────────────────┤
         │                         │                            │
         ▼                         ▼                            ▼
  ┌─────────────┐       ┌───────────────────────┐     ┌─────────────────┐
  │   Parser    │       │ FileGraphResolver     │     │  ConfigLoader   │
  └─────────────┘       └───────────┬───────────┘     └────────┬────────┘
                                    │                          │
                                    ▼                          │
                          ┌─────────────────┐                  │
                          │   FileCopier    │                  │
                          └────────┬────────┘                  │
                                   │                           │
     ┌─────────────────────────────┼───────────────────────────┤
     │                             │                           │
     ▼                             ▼                           ▼
┌─────────────────┐     ┌───────────────────────┐     ┌─────────────┐
│ReexportGenerator│     │  ContractsPipeline    │     │   cli.ts    │
└─────────────────┘     │ (orchestrator)        │     │             │
                        └───────────┬───────────┘     └──────┬──────┘
                                    │                        │
                                    ▼                        ▼
                        ┌───────────────────────────────────────────┐
                        │              index.ts (exports)           │
                        │           processContext() API            │
                        └───────────────────────────────────────────┘
```

---

## Key Design Patterns

| Pattern | Usage |
|---------|-------|
| **Discriminated Union** | `kind` field in `TypeRef` for type discrimination |
| **Type Guards** | `isPrimitiveType()`, `isDomainEvent()`, etc. |
| **Decorator** | `@ContractEvent`, `@ContractCommand`, `@ContractQuery`, and generic `@Contract({ kind })` markers |
| **Compatibility Decorator** | Deprecated `PublicEvent`, `PublicCommand`, `PublicQuery`, and `PublicContract` aliases |
| **Comment Marker** | Leading `@Contract(...)` comments for general contracts, with legacy `@PublicContract()` still supported |
| **Visitor** | AST node traversal (Parser) |
| **Graph Traversal** | BFS for import dependency exploration |
| **Facade** | `processContext()` encapsulates entire pipeline |
| **Factory Method** | `ContractsPipeline.create()`, `FileGraphResolver.create()` |
| **Dependency Injection** | `FileSystem`, `Logger` interfaces for DI |
| **Strategy** | `FileSystem` implementation swap for test/production separation |
| **Error Hierarchy** | Hierarchical errors based on `MessageParserError` |

---

## Public Exports

### Types
```typescript
// Domain Types
SourceFile, TypeRef, Field, DomainEvent, Command, Query, Message
TypeDefinition, TypeDefinitionKind, ClassDefinition, ClassImport
EnumDefinition, EnumMember
ExtractionResult, ExtractionError, ExtractionWarning, Config
Dependency, DependencyKind, ImportSource
MessageBase, MessageType, ContractDeclaration, ContractKind, ContractVisibility
ContractOutputConfig, ContractOutputSelect, PublicContract, PublicContractDeclarationKind

// Type Variants
PrimitiveType, ArrayType, ObjectType, UnionType, IntersectionType
ReferenceType, LiteralType, TupleType, FunctionType, FunctionParameter

// Type Guards
isPrimitiveType, isArrayType, isObjectType, isUnionType
isIntersectionType, isReferenceType, isLiteralType
isTupleType, isFunctionType, isDomainEvent, isCommand, isQuery

// Infrastructure Types
FileSystem, FileStats
Logger, LogLevel, ConsoleLoggerOptions

// Pipeline Types
PipelineDependencies, PipelineOptions, PipelineResult, ParsedMessages
ProcessContextOptions, ProcessContextResult

// Config Types
ContractsConfig, ContextConfig, DecoratorNames, ContractMarkerNames
ScannerOptions, ParseResult

// Runtime Types
MessageHeaders, MessageClass, Version

// Generator Types
RegistryGeneratorOptions, ContextMessages
RewrittenImport, ReexportFile, ReexportGeneratorOptions
```

### Classes
```typescript
// Core Classes
Scanner, Parser, FileGraphResolver, FileCopier
ContextConfig, ConfigLoader
ContractsPipeline, RegistryGenerator, ReexportGenerator

// Runtime Classes
MessageRegistry

// Infrastructure
ConsoleLogger
nodeFileSystem  // Singleton instance
noopLogger      // Singleton instance

// Error Classes
MessageParserError
├── BoundaryViolationError
├── ConfigurationError
│   └── ConfigLoadError
├── FileSystemError
│   ├── FileNotFoundError
│   ├── FileReadError
│   └── FileWriteError
├── ParseError
│   └── JsonParseError
└── ResolutionError
    └── ModuleResolutionError
```

### Functions
```typescript
processContext(options: ProcessContextOptions): Promise<ProcessContextResult>
```

### Contract Decorators (in `@hexaijs/contracts/decorators`)
```typescript
@ContractEvent(options?: ContractEventOptions)
@ContractCommand(options?: ContractCommandOptions)
@ContractQuery(options?: ContractQueryOptions)
@Contract(options?: ContractOptions)

// Deprecated aliases, kept without runtime warnings:
@PublicEvent(options?: PublicEventOptions)
@PublicCommand(options?: PublicCommandOptions)
@PublicQuery(options?: PublicQueryOptions)
@PublicContract(options?: PublicContractOptions)
```

`ContractOptions` extends the shared `visibility`, `tags`, and `context` fields with `kind?`, `response?`, and `version?`. `response?` is used for generic command/query contracts, and `version?` is used for generic event contracts.

### Comment Markers
```typescript
// @Contract({ kind: "read-model", visibility: "public", tags: ["frontend"] })
/* @Contract({ kind: "value-object" }) */
/** @Contract({ kind: "snapshot", visibility: "internal" }) */

// Deprecated compatibility markers:
// @PublicContract()
/* @PublicContract() */
/** @PublicContract() */
```

`Contract` is a no-op class decorator and an import-free comment marker name. Interfaces, type aliases, and enums use comment markers only. `PublicContract` remains the default legacy comment marker name configured by `contractMarkerNames`.

### CLI
```bash
# Standalone CLI
generate-contracts -o <output-dir> [--config <path>] [--include all|messages|contracts] [--messages event,command,query] [--entry-strategy graph|symbols] [--registry] [--dry-run] [--check]

# hexai CLI plugin
pnpm hexai generate-contracts -o <output-dir> [--include all|messages|contracts] [--messages event,command,query] [--entry-strategy graph|symbols] [--registry] [--dry-run] [--check]
```

Legacy aliases remain supported: `-m, --message-types` maps to `--messages`, and `--generate-message-registry` maps to `--registry`.
