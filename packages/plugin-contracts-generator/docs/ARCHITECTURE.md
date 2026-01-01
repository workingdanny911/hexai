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
├── decorators/           # @PublicEvent/@PublicCommand decorators
│   └── index.ts
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
├── scanner.ts            # Find decorated files
├── parser.ts             # Extract events/commands from AST
├── ast-utils.ts          # Low-level AST manipulation
├── import-analyzer.ts    # Import statement analysis
├── class-analyzer.ts     # Class declaration analysis
├── file-graph-resolver.ts # Build import dependency graph
├── file-copier.ts        # Copy files with import rewriting
├── config-loader.ts      # Load application.config.ts
├── tsconfig-loader.ts    # Load path aliases
├── registry-generator.ts # Generate MessageRegistry registration code
├── reexport-generator.ts # Generate re-export files for path alias rewrites
├── test-utils.ts         # Test utilities
│
└── runtime/              # Runtime utilities (used by contracts package)
    ├── index.ts
    └── message-registry.ts  # Message class registry for deserialization
```

## Module Overview

### 1. Decorators (`src/decorators/`)

Provides decorators that add metadata at runtime. Since the Parser performs static analysis only, actual runtime effects are optional.

```typescript
// Public Interface
@PublicEvent(options?: PublicEventOptions)
@PublicCommand(options?: PublicCommandOptions)

interface PublicEventOptions {
  version?: number;
  context?: string;
}

interface PublicCommandOptions {
  context?: string;
}

// Metadata Symbols
const PUBLIC_EVENT_METADATA: symbol
const PUBLIC_COMMAND_METADATA: symbol

// Metadata Helpers
getPublicEventMetadata(target: object): PublicEventOptions | undefined
getPublicCommandMetadata(target: object): PublicCommandOptions | undefined
isPublicEventClass(target: object): boolean
isPublicCommandClass(target: object): boolean
```

**Dependencies**: `reflect-metadata`

---

### 2. Scanner (`src/scanner.ts`)

Finds files containing `@PublicEvent` or `@PublicCommand` decorators in the source directory.

```typescript
interface ScannerOptions {
  exclude?: string[];  // Exclude glob patterns
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

**Algorithm**:
1. Traverse all TypeScript files using `**/*.ts` glob
2. Search file contents for `@PublicEvent(` or `@PublicCommand(` text
3. Return matching file paths

**Characteristics**: Optimizes performance with fast text matching before AST parsing

---

### 3. Parser (`src/parser.ts`)

Analyzes TypeScript AST to extract Event/Command class information.

```typescript
interface ParseResult {
  readonly events: readonly DomainEvent[]
  readonly commands: readonly Command[]
}

class Parser {
  parse(sourceCode: string): ParseResult
}
```

**Extraction Process**:
1. Generate TypeScript AST
2. Traverse `ClassDeclaration` nodes
3. Check decorators (`@PublicEvent`, `@PublicCommand`)
4. Extract payload type (`extends Message<PayloadType>`)
5. Collect class imports and dependencies
6. Extract base class name

**Extracted Data**:
- `name`: Class name
- `fields`: Payload field list
- `payloadType`: Original type reference
- `sourceText`: Complete class source code
- `imports`: All import statements in the file
- `baseClass`: Inherited class name

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
  removeDecorators?: boolean               // Remove @PublicCommand/@PublicEvent decorators
  messageTypes?: MessageType[]             // Message types to extract ('event' | 'command' | 'query')
  decoratorNames?: string[]                // Decorator names for each messageType
  responseTypesToExport?: Map<string, string>  // Message class → Response type name mapping
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
| **Entry files** | Symbol extraction + Import filtering | Exclude handlers and unnecessary code |
| **Dependency files** | Full module copy | Simplification, automatic barrel file support |

**Entry File Symbol Extraction (`extractSymbolsFromEntry()`)**:
1. Extract only `@Public*` classes matching `messageTypes`
2. Extract Response types for those classes (naming convention)
3. BFS tracking of local type dependencies
4. Filter and keep only used imports

**Import Rewriting**:
1. Internal path alias → relative path conversion (e.g., `@core/types` → `./types`)
2. External path alias → specified prefix conversion (e.g., `@libera/common` → `@/common`)

**Additional Features**:
- **Excluded file import removal**: Automatically removes import/export statements referencing files in `FileGraph.excludedPaths`
- **Decorator removal**: Removes `@PublicCommand`, `@PublicEvent` decorators and related imports when `removeDecorators: true`
- **Transitive dependency tracking**: Includes dependencies of dependencies via FileGraph-based BFS, not just direct imports from entry files

---

### 7. TSConfig Loader (`src/tsconfig-loader.ts`)

Loads path alias configuration from tsconfig.json.

```typescript
interface PathAliasConfig {
  readonly baseUrl: string
  readonly paths: Map<string, string[]>  // Alias pattern → target paths
}

class TsconfigLoader {
  load(tsconfigPath: string): PathAliasConfig
}
```

**Features**:
- Recursive `extends` resolution
- JSON with Comments support
- `compilerOptions.paths` interpretation
- Parent/child config merging

---

### 8. Config Loader (`src/config-loader.ts`)

Loads contracts configuration from `application.config.ts`.

```typescript
interface ContextConfig {
  readonly name: string           // Context name (e.g., 'lecture')
  readonly sourceDir: string      // Source directory to scan
  readonly tsconfigPath?: string  // Optional path alias config
}

interface OutputPackageConfig {
  readonly name: string           // Package name (e.g., '@libera/contracts')
  readonly dir: string            // Package directory (e.g., 'packages/contracts')
}

interface ContractsConfig {
  readonly contexts: readonly ContextConfig[]
  readonly outputPackage: OutputPackageConfig
  readonly pathAliasRewrites?: Readonly<Record<string, string>>
  readonly externalDependencies?: Readonly<Record<string, string>>
}

class ConfigLoader {
  async load(configPath: string): Promise<ContractsConfig>
}

class ConfigLoadError extends Error {
  constructor(message: string)
}
```

**Context Resolution**:
- String path: `'packages/lecture'` → Load application.config.ts from that package
- Glob pattern: `'packages/*'` → Automatically discover all matching packages
- Object: `{ name, sourceDir, tsconfigPath? }`

**Package Config Requirements**:
- `contextName`: Required, context name
- `sourceDir`: Required, source directory to scan
- `tsconfigPath`: Optional, path alias config path

---

### 9. CLI (`src/cli.ts`)

Command-line interface and full pipeline orchestration.

```bash
Usage: contracts-generator [options]

Options:
  -c, --config <path>   Path to config file (default: application.config.ts)
  -h, --help            Show this help message
```

**Programmatic API**:
```typescript
async function run(args: string[]): Promise<void>
```

**Processing Flow**:
1. Load config
2. Call processContext for each context
3. Output results (events, commands, queries, files count)

---

### 10. hexai Plugin (`src/hexai-plugin.ts`)

CLI plugin definition for integration with the hexai CLI tool.

```typescript
export const cliPlugin: HexaiCliPlugin<ContractsPluginConfig> = {
  name: "generate-contracts",
  description: "Extract domain events, commands, and queries from bounded contexts",
  options: [
    { flags: "-o, --output-dir <path>", description: "Output directory", required: true },
    { flags: "-m, --message-types <types>", description: "Filter message types" },
    { flags: "--generate-message-registry", description: "Generate message registry" },
  ],
  run: async (args, config) => { ... }
}
```

**Usage**:
```bash
pnpm hexai generate-contracts -o packages/contracts/src
pnpm hexai generate-contracts -o packages/contracts/src -m event,command
pnpm hexai generate-contracts -o packages/contracts/src --generate-message-registry
```

---

### 11. Main Entry Point (`src/index.ts`)

Provides the programmatic API.

```typescript
interface ProcessContextOptions {
  contextName: string
  sourceDir: string
  outputDir: string
  pathAliasRewrites?: Map<string, string>
  tsconfigPath?: string
  fileSystem?: FileSystem           // File system abstraction (default: nodeFileSystem)
  logger?: Logger                   // Logger instance (default: noopLogger)
  messageTypes?: MessageType[]      // Message types to extract ('event' | 'command' | 'query')
  removeDecorators?: boolean        // Remove @Public* decorators from output
  responseNamingConventions?: string[]  // Patterns for matching response types
}

interface ProcessContextResult {
  events: DomainEvent[]
  commands: Command[]
  queries: Query[]
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
| parse | debug | Parse start, extracted events/commands count |
| resolve | debug | Dependency resolution start, graph node count |
| copy | debug | Copy start, copied file count |

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
}

interface PipelineResult {
  readonly events: DomainEvent[]
  readonly commands: Command[]
  readonly queries: Query[]
  readonly copiedFiles: string[]
}

interface ParsedMessages {
  readonly events: DomainEvent[]
  readonly commands: Command[]
  readonly queries: Query[]
}

class ContractsPipeline {
  // Factory method (auto-configure dependencies)
  static async create(options?: {
    tsconfigPath?: string
    fileSystem?: FileSystem
    logger?: Logger
  }): Promise<ContractsPipeline>

  // Test factory (direct dependency injection)
  static fromDependencies(deps: PipelineDependencies): ContractsPipeline

  // Execute full pipeline
  async execute(options: PipelineOptions): Promise<PipelineResult>

  // Step-by-step methods (for testing)
  async scan(sourceDir: string): Promise<string[]>
  async parse(files: string[], sourceRoot: string): Promise<ParsedMessages>
  async resolve(entryPoints: string[], sourceRoot: string): Promise<FileGraph>
  async copy(graph: FileGraph, sourceRoot: string, outputDir: string, rewrites?: Map<string, string>): Promise<string[]>
  async exportBarrel(graph: FileGraph, outputDir: string): Promise<void>
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
│   ├── ConfigLoadError
│   └── TsconfigLoadError
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

Automatically generates MessageRegistry registration code based on extracted Events/Commands.

```typescript
interface RegistryGeneratorOptions {
  readonly messageRegistryImport: string  // Default: "@hexaijs/plugin-contracts-generator/runtime"
  readonly useNamespace?: boolean         // Default: false, true enables namespace mode
}

interface ContextMessages {
  readonly contextName: string
  readonly events: readonly DomainEvent[]
  readonly commands: readonly Command[]
  readonly importPath?: string
}

class RegistryGenerator {
  constructor(options?: Partial<RegistryGeneratorOptions>)
  generate(contexts: readonly ContextMessages[]): string
}
```

**Namespace Mode** (default, `useNamespace: true`):

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

**Legacy Mode** (`useNamespace: false`):
```typescript
import { MessageRegistry } from "@hexaijs/plugin-contracts-generator/runtime";
import { LectureCreated, LectureExpanded } from "./lecture";
import { VideoLessonStarted } from "./video-lesson";

export const messageRegistry = new MessageRegistry()
    .register(LectureCreated)
    .register(LectureExpanded)
    .register(VideoLessonStarted);
```

**Note**: Legacy mode causes `Duplicate identifier` errors when classes with the same name exist in multiple contexts

**kebab-case → camelCase Conversion**:
- `video-lesson` → `videoLesson`
- `topic-generation` → `topicGeneration`

**Purpose**:
- Auto-generate MessageRegistry registration code for contracts package's `index.ts`
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
│  (contexts, outputPackage, pathAliasRewrites)                                  │
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
│  @Public* decorator file discovery + messageTypes decorator filtering          │
│  Output: string[] (entry files)                                                │
└────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│  2. PARSE (Parser)                                                             │
│  ─────────────────                                                             │
│  Message class parsing + Response matching by naming convention                │
│  Collect only symbols matching messageTypes                                    │
│  Output: ParsedMessages (commands, events, queries, typeDefinitions)           │
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
│  4. COPY (FileCopier) - Two-Pass Approach                                      │
│  ────────────────────────────────────────                                      │
│                                                                                │
│  Pass 1: Entry file processing                                                 │
│   - Symbol extraction: Extract only @Public* classes                           │
│   - Response type extraction (naming convention)                               │
│   - BFS tracking of local type dependencies                                    │
│   - Path alias → relative path conversion, then import extraction              │
│                                                                                │
│  Pass 1.5: Transitive dependency expansion                                     │
│   - Recursively expand usedLocalImports via FileGraph-based BFS               │
│                                                                                │
│  Pass 2: Dependency file processing                                            │
│   - Copy only used dependencies as full modules                                │
│   - Common post-processing: decorator removal, path alias conversion           │
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
  │   Scanner   │      │   TS Utils (separated) │        │tsconfig-loader│
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
| **Decorator** | `@PublicEvent`, `@PublicCommand` |
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
MessageBase, MessageType

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
ContractsConfig, ContextConfig, OutputPackageConfig
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
TsconfigLoader, ConfigLoader
ContractsPipeline, RegistryGenerator, ReexportGenerator

// Runtime Classes
MessageRegistry

// Infrastructure
ConsoleLogger
nodeFileSystem  // Singleton instance
noopLogger      // Singleton instance

// Error Classes
MessageParserError
├── ConfigurationError
│   ├── ConfigLoadError
│   └── TsconfigLoadError
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

### Decorators
```typescript
@PublicEvent(options?: PublicEventOptions)
@PublicCommand(options?: PublicCommandOptions)
```

### CLI
```bash
# Standalone CLI
contracts-generator [--config <path>] [--help]

# hexai CLI plugin
pnpm hexai generate-contracts -o <output-dir> [-m <message-types>] [--generate-message-registry]
```
