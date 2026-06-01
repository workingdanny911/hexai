# @hexaijs/plugin-contracts-generator

> Extract message contracts and general TypeScript contracts from backend source code to generate frontend-compatible types

## Overview

`@hexaijs/plugin-contracts-generator` solves the problem of keeping frontend and backend type definitions in sync. In a hexagonal architecture, your backend defines domain events, commands, queries, and shared public contracts - but your frontend also needs type-safe access to these message types and general contract declarations for API calls, event handling, and validation.

Instead of manually duplicating type definitions (which inevitably drift out of sync), this plugin scans your backend source code for contract decorators and contract markers, then extracts the matching declarations into one or more standalone contracts packages. The generated package can contain the public API surface, an internal build-tool surface, or both via configured outputs - message types, their payloads, response types, and explicitly marked general contracts - without backend implementation details.

The plugin works at build time by:

1. Scanning TypeScript files for message classes decorated with `@ContractEvent()`, `@ContractCommand()`, or `@ContractQuery()`, generic `@Contract({ kind })` declarations, plus leading `@Contract(...)` comment markers
2. Resolving all type dependencies (including response types, shared value objects, and general contract declarations)
3. Generating clean contracts packages with namespace exports and, when requested, a MessageRegistry for selected decorated messages only

## Installation

```bash
npm install @hexaijs/plugin-contracts-generator
```

**Peer dependencies:**
- `typescript ^5.0.0 || ^6.0.0`

## Core Concepts

### Contract Decorators

The package provides message-specific decorators and a generic contract decorator. These decorators have **no runtime overhead** - they simply tag classes for discovery during the build process. Selected message contracts are the only generated contracts registered in `MessageRegistry`.

```typescript
import {
    Contract,
    ContractCommand,
    ContractEvent,
    ContractQuery,
} from "@hexaijs/contracts/decorators";
```

**@ContractEvent()** - Marks a domain event contract:

```typescript
import { DomainEvent } from "@hexaijs/core";
import { ContractEvent } from "@hexaijs/contracts/decorators";

@ContractEvent()
export class OrderPlaced extends DomainEvent<{
    orderId: string;
    customerId: string;
    totalAmount: number;
}> {
    static readonly type = "order.order-placed";
}
```

**@ContractCommand()** - Marks a command contract:

```typescript
import { ContractCommand } from "@hexaijs/contracts/decorators";

@ContractCommand({ response: "CreateOrderResponse" })
export class CreateOrderRequest extends BaseRequest<{
    customerId: string;
    items: OrderItem[];
}> {
    static type = "order.create-order";
}

export type CreateOrderResponse = {
    orderId: string;
};
```

**@ContractQuery()** - Marks a query contract:

```typescript
import { ContractQuery } from "@hexaijs/contracts/decorators";

@ContractQuery({ response: "OrderDetails" })
export class GetOrderQuery extends BaseRequest<{
    orderId: string;
}> {}

type OrderDetails = {
    orderId: string;
    status: string;
    items: OrderItem[];
};
```

**@Contract({ kind })** - Marks a generic contract role. Built-in message kinds are `command`, `query`, and `event`; custom kinds such as `read-model`, `value-object`, `dto`, or `snapshot` are treated as general contracts unless they are one of the built-in message kinds.

```typescript
import { Contract } from "@hexaijs/contracts/decorators";

@Contract({ kind: "read-model", tags: ["frontend"] })
export class OrderListItem {
    orderId!: string;
    status!: string;
    totalAmount!: number;
}

@Contract({ kind: "command", visibility: "internal" })
export class RebuildOrderProjectionCommand {
    static type = "order.rebuild-projection";
}
```

Each decorator accepts optional configuration:
- `context` - Override the context name for this message
- `version` - Specify a version number for versioned events
- `response` - Explicitly name the response type (for commands/queries)
- `visibility` - Select the boundary for output filtering. Defaults to `"public"`; use `"internal"` for contracts that must not be emitted to public outputs unless selected explicitly
- `tags` - Auxiliary labels for additional output filters. Tags are not a security boundary
- `kind` - Generic contract role/discriminator for `@Contract(...)`; message-specific decorators provide it implicitly

Use `visibility` for public/internal separation. Use `tags` only for secondary grouping such as `"frontend"`, `"bus"`, `"admin"`, or `"experimental"`.

### Contract Comment Markers

General contracts that are not messages can be exposed with `@Contract({ kind: "contract" })` or a custom `kind`. Classes support the no-op runtime decorator form. Interfaces, type aliases, and enums do not support TypeScript decorators, so they must use a leading comment marker.

Comment markers can be line comments, block comments, or JSDoc comments placed immediately before a `class`, `interface`, `type`, or `enum` declaration. Interfaces, type aliases, and enums are comment-marker only. Comment markers require no import. They must use call syntax such as `// @Contract({ kind: "dto" })` or `// @PublicContract()`; bare markers such as `// @PublicContract` are not supported. If the marked declaration is not exported in the source file, the generator adds `export` in the generated contracts output.

```typescript
@Contract({ kind: "snapshot" })
export class OrderSnapshotContract {
    constructor(public readonly orderId: string) {}
}

// @Contract({ kind: "snapshot", visibility: "public", tags: ["frontend"] })
interface OrderSnapshot {
    orderId: string;
    status: OrderStatus;
    totalAmount: number;
}

/* @Contract({ kind: "value-object" }) */
enum OrderChannel {
    Online = "online",
    Store = "store",
}

/** @Contract({ kind: "read-model", visibility: "internal", tags: ["admin"] }) */
type OrderStatus = "draft" | "placed" | "cancelled";
```

General contracts are included in the generated contracts output, but they are not message contracts and are never registered in `MessageRegistry`. `MessageRegistry` registers selected decorated messages only.

Legacy `@PublicContract()` comment markers still work and map to `@Contract({ kind: "contract", visibility: "public" })`.

### Configuration

Create an `application.config.ts` file in your monorepo root:

```typescript
// application.config.ts
export default {
    contracts: {
        // Context definitions (required)
        contexts: [
            {
                name: "order",
                path: "packages/order",
                tsconfigPath: "tsconfig.json", // optional, relative to path
            },
            {
                name: "inventory",
                path: "packages/inventory",
                sourceDir: "lib", // optional, defaults to "src"
            },
        ],

        // Path alias rewrite rules (optional)
        pathAliasRewrites: {
            "@myorg/": "@/",
        },

        // Additional dependencies for contracts package (optional)
        externalDependencies: {
            "@hexaijs/core": "workspace:*",
        },

        // Multiple outputs are optional. If omitted, use --output-dir.
        outputs: [
            {
                name: "public",
                path: "packages/contracts/src",
                select: {
                    visibility: ["public"],
                },
            },
            {
                name: "internal",
                path: "packages/contracts-internal/src",
                registry: true,
                select: {
                    visibility: ["internal"],
                    messageKinds: ["command"],
                    tags: { include: ["bus"] },
                },
            },
        ],

        // Response type naming conventions (optional)
        responseNamingConventions: [
            { messageSuffix: "Command", responseSuffix: "CommandResult" },
            { messageSuffix: "Query", responseSuffix: "QueryResult" },
            { messageSuffix: "Request", responseSuffix: "Response" },
        ],

        // Legacy custom decorator names (optional, defaults shown)
        decoratorNames: {
            event: "PublicEvent",
            command: "PublicCommand",
            query: "PublicQuery",
        },

        // Legacy custom comment marker names for general contracts (optional, defaults shown)
        contractMarkerNames: {
            contract: "PublicContract",
        },

        // Trusted local barrels that re-export Contract* decorators (optional)
        trustedDecoratorSources: ["@app/contracts"],

        // Entry strategy (optional, default: "symbols")
        entryStrategy: "symbols",

        // Strip decorators from generated output (optional, default: true)
        removeDecorators: true,
    },
};
```

The canonical API names `ContractEvent`, `ContractCommand`, `ContractQuery`, and `Contract` are recognized when they are imported from trusted decorator sources. Unbound canonical `Contract*` names are ignored to avoid false positives. `decoratorNames` and `contractMarkerNames` keep their legacy replacement semantics for existing projects that use custom `Public*` marker names.

When `removeDecorators: true` is enabled, generated files are printed through the TypeScript printer after matched contract decorators and related imports are removed. Migration diffs can therefore include formatting churn around affected declarations in addition to the expected decorator removal.

Each context requires `name` and `path`. The `path` is the base directory of the context (relative to the config file). Within that directory:
- `sourceDir` defaults to `"src"` (resolved relative to `path`)
- `tsconfigPath` defaults to `"tsconfig.json"` (resolved relative to `path`)

For monorepos with many packages, use glob patterns to auto-discover contexts:

```typescript
export default {
    contracts: {
        contexts: ["packages/*"],  // Matches all directories under packages/
    },
};
```

Each matched directory is treated as a context with sensible defaults:
- Context name = directory name (e.g., `packages/auth` → `auth`)
- Source directory = `src/` (default)
- TypeScript config = `tsconfig.json` (auto-detected if exists)

### Multiple Outputs

Use `contracts.outputs[]` when a monorepo needs more than one generated package. Output paths are resolved relative to the config file. When `outputs[]` is configured, run without `--output-dir`/`-o`; the CLI rejects the combination to avoid writing the same run to two different output plans.

**Simple monorepo root config:**

```typescript
// application.config.ts
export default {
    contracts: {
        contexts: ["packages/*"],
        outputs: [
            {
                name: "public",
                path: "packages/contracts/src",
                select: { visibility: ["public"] },
            },
        ],
    },
};
```

**Public/internal split:**

```typescript
export default {
    contracts: {
        contexts: [
            { name: "orders", path: "packages/orders" },
            { name: "billing", path: "packages/billing" },
        ],
        outputs: [
            {
                name: "public",
                path: "packages/contracts/src",
                select: {
                    visibility: ["public"],
                    include: "all",
                },
            },
            {
                name: "internal-command-bus",
                path: "packages/internal-contracts/src",
                registry: true,
                select: {
                    visibility: ["internal"],
                    messageKinds: ["command"],
                    tags: { include: ["bus"] },
                },
            },
        ],
    },
};
```

`outputs[].select` supports:

| Field | Description |
|-------|-------------|
| `visibility` | Primary public/internal boundary. Use `["public"]` for frontend packages and `["internal"]` for internal build targets |
| `kinds` | Match any contract kind, including custom generic `kind` values |
| `messageKinds` | Match only message kinds: `command`, `query`, or `event` |
| `include` | Select contract categories: `all`, `messages`, or `contracts` |
| `tags.include` | Keep contracts that have at least one included tag |
| `tags.exclude` | Drop contracts that have any excluded tag |

`outputs[].registry: true` generates a `MessageRegistry` for that output. General contracts are still exported but never registered.

If `outputs[]` is omitted, existing single-output mode remains unchanged:

```bash
npx generate-contracts --output-dir packages/contracts/src
```

CLI filters such as `--include`, `--messages`, and `--registry` still apply to single-output mode. With `outputs[]`, use output-level `select` and `registry`; passing `--registry` enables registry generation for every configured output.

### Response Types

Commands and queries often have associated response types. The generator includes these in the contracts package automatically.

**Automatic detection via naming conventions:**

```typescript
// When responseNamingConventions includes { messageSuffix: "Command", responseSuffix: "CommandResult" }

@ContractCommand()
export class CreateOrderCommand extends Message<{ customerId: string }> {}

type CreateOrderCommandResult = {  // Automatically detected by naming pattern
    orderId: string;
};
```

**Explicit response option:**

```typescript
@ContractCommand({ response: "OrderCreationResult" })
export class CreateOrder extends Message<{ customerId: string }> {}

type OrderCreationResult = {
    orderId: string;
    createdAt: Date;
};
```

Response types must be in the same file as the command/query. Both `type` aliases and `interface` declarations are supported. The generator adds `export` automatically if the type isn't already exported.

### Entry vs Dependency Files

The generator handles two types of files differently:

**Entry files** (files with message decorators, `@Contract(...)` class decorators, or leading `@Contract(...)` comment markers) are contract entry points:
- The default `entryStrategy` is `symbols`, which extracts selected declarations and filters imports for generated contract packages
- Use `entryStrategy: "graph"` or `--entry-strategy graph` when you intentionally want to copy selected entry files and their dependency graphs
- Under `graph`, message/output filters select graph roots and registry entries only; selected entry files can still be copied whole with other declarations from the same file, and the generator logs a warning when filters or strict output selection are used
- In `symbols`, matching decorated message classes and marked public contract declarations are extracted with minimal local dependencies
- In `symbols`, selected entry files preserve retained default imports, namespace imports, named aliases, mixed default + named imports, type-only default imports, and qualified type references such as `Types.User` or `Types.Inner.User`
- In `symbols`, unused named specifiers in retained mixed imports are removed when the AST shape is safe to rewrite, and already-exported local function dependencies are preserved without adding a duplicate `export`
- Response types are included based on naming conventions

**Dependency files** (imported by entry files) are copied entirely:
- Supports barrel files (`export * from './module'`)
- Preserves all exports for transitive dependencies
- Ensures type dependencies remain intact

`symbols` is still an AST-based slicer, not a full TypeScript TypeChecker semantic slicer. Dependency files referenced by retained local imports are copied as whole files; they are not symbol-sliced. With strict output selectors, the generator fails fast with `BoundaryViolationError` if copying would include a marked declaration outside the selected output. Keep public DTO/value-object dependencies boundary-clean and separate from internal implementation modules.

## Usage

### CLI

Run the generator from your monorepo root:

```bash
# In single-output mode, --output-dir (-o) specifies where contracts are generated
npx generate-contracts --output-dir packages/contracts/src

# Specify config file path (default: application.config.ts)
npx generate-contracts -o packages/contracts/src --config ./app.config.ts
```

By default, the CLI uses `--include all`, all message types, and `--entry-strategy symbols`. In single-output mode this generates public `@ContractEvent()`, `@ContractCommand()`, and `@ContractQuery()` message contracts plus marked general `@Contract(...)` declarations as a strict public contract surface. Legacy `Public*` markers are still recognized.

| Option | Description |
|--------|-------------|
| `-o, --output-dir <path>` | Output directory for single-output mode; required unless `contracts.outputs[]` is configured |
| `-c, --config <path>` | Config file path (default: `application.config.ts`) |
| `--include <scope>` | Select generated contract categories: `all`, `messages`, or `contracts` |
| `--messages <types>` | Recommended message subtype filter. Accepts comma-separated `event`, `command`, and `query` values |
| `-m, --message-types <types>` | Legacy alias for `--messages`; kept for backwards compatibility |
| `--entry-strategy <strategy>` | Entry strategy: `symbols` strictly extracts selected declarations (default); `graph` copies selected entry file graphs |
| `--registry` | Generate the root `MessageRegistry` export |
| `--generate-message-registry` | Legacy verbose alias for `--registry` |
| `--dry-run` | Print the planned context extraction and file summary without writing files |
| `--check` | Verify generated output freshness for CI and exit non-zero when changes are required |

`--include contracts` generates only general contract declarations. `--include messages` generates only decorated messages. `--messages` filters only the message subtypes and does not exclude general contracts when `--include all` is used. In the default `symbols` strategy, retained local imports can use default, namespace, aliased named, mixed default + named, and type-only default import forms; qualified namespace references are tracked in selected entry files. Use `--entry-strategy graph` for conservative entry file graph copying. Under `graph`, message filters and output selectors choose graph roots and registry entries only; selected entry files can still be copied whole with other declarations from the same file, and the generator logs a warning. Use `symbols` for strict public/internal splits. The generated `MessageRegistry` registers selected decorated messages only; general contracts are never registered.

### hexai CLI Plugin

When loaded through `hexai.config.ts`, the same options are available through the `hexai` plugin command:

```typescript
// hexai.config.ts
export default {
    plugins: [
        {
            plugin: "@hexaijs/plugin-contracts-generator",
            config: {
                contexts: ["packages/*"],
                entryStrategy: "symbols",
                contractMarkerNames: { contract: "PublicContract" },
            },
        },
    ],
};
```

```bash
pnpm hexai generate-contracts -o packages/contracts/src --registry
pnpm hexai generate-contracts -o packages/contracts/src --include messages --messages event,command
pnpm hexai generate-contracts -o packages/contracts/src --entry-strategy graph
```

For configured outputs, put `outputs[]` in the plugin config and run without `-o`:

```typescript
// hexai.config.ts
export default {
    plugins: [
        {
            plugin: "@hexaijs/plugin-contracts-generator",
            config: {
                contexts: ["packages/*"],
                outputs: [
                    {
                        name: "public",
                        path: "packages/contracts/src",
                        select: { visibility: ["public"] },
                    },
                    {
                        name: "internal",
                        path: "packages/contracts-internal/src",
                        registry: true,
                        select: { visibility: ["internal"] },
                    },
                ],
            },
        },
    ],
};
```

```bash
pnpm hexai generate-contracts
```

Passing `-o`/`--output-dir` together with configured `outputs[]` is rejected.

Common workflows:

```bash
# Preview the plan, then generate contracts with a MessageRegistry
npx generate-contracts -o packages/contracts/src --dry-run
npx generate-contracts -o packages/contracts/src --registry

# Generate messages only
npx generate-contracts -o packages/contracts/src --include messages --messages event,command

# Generate general contracts only
npx generate-contracts -o packages/contracts/src --include contracts

# Opt into conservative entry file graph copying
npx generate-contracts -o packages/contracts/src --messages event --entry-strategy graph

# CI freshness check
npx generate-contracts -o packages/contracts/src --check

# Generate configured outputs without --output-dir
npx generate-contracts --config application.config.ts
```

### Import and Source Matching

Decorator syntax is import/source-aware for canonical `Contract*` names. The matcher trusts decorators imported as named value imports from:

- `@hexaijs/contracts`
- `@hexaijs/contracts/decorators`
- any configured `contracts.trustedDecoratorSources[]` entry

Named import aliases are supported:

```typescript
import { ContractCommand as InternalCommand } from "@hexaijs/contracts/decorators";

@InternalCommand({ visibility: "internal", tags: ["bus"] })
export class RebuildSearchIndexCommand {}
```

Same-named decorators imported from unrelated packages are ignored. Type-only imports are not treated as decorator bindings. Comment markers need no import because they are matched from declaration-leading comments.

Local barrels are intentionally conservative. If a local package re-exports the contract decorators, add that import source to `contracts.trustedDecoratorSources` or prefer importing directly from `@hexaijs/contracts/decorators`. The generator does not automatically trace arbitrary multi-hop re-export chains.

Namespace decorator imports are not supported:

```typescript
import * as Contracts from "@hexaijs/contracts/decorators";

@Contracts.ContractCommand() // Not matched as a contract decorator
export class CreateOrderCommand {}
```

Namespace imports remain supported for ordinary type dependencies in generated contract files; only namespace decorator calls are unsupported.

### Migration from Public* Markers

`PublicEvent`, `PublicCommand`, `PublicQuery`, and `PublicContract` still work as deprecated aliases. They map to canonical `Contract*` metadata with `visibility: "public"`. The runtime decorators do not emit deprecation warnings.

Recommended migration:

1. Replace imports from `PublicEvent`, `PublicCommand`, and `PublicQuery` with `ContractEvent`, `ContractCommand`, and `ContractQuery`.
2. Replace `@PublicContract()` class decorators with `@Contract({ kind: "contract" })` or a more specific custom kind such as `read-model`, `value-object`, `dto`, or `snapshot`.
3. Replace `// @PublicContract()` comment markers with `// @Contract({ kind: "contract" })` or a specific `kind`.
4. Add `visibility: "internal"` only to contracts that should be excluded from public outputs.
5. Add `outputs[]` with `select.visibility` before publishing internal contracts from the same source tree.
6. Keep `entryStrategy: "symbols"` for strict public/internal split generation.

### Programmatic API

For custom build scripts:

```typescript
import { processContext, ConsoleLogger } from "@hexaijs/plugin-contracts-generator";

const result = await processContext({
    contextName: "order",
    path: "packages/order",
    sourceDir: "src",
    outputDir: "packages/contracts/src",
    pathAliasRewrites: new Map([["@myorg/", "@/"]]),
    contractMarkerNames: { contract: "PublicContract" },
    messageTypes: ["event", "command"],
    includePublicContracts: true,
    entryStrategy: "symbols",
    responseNamingConventions: [
        { messageSuffix: "Command", responseSuffix: "CommandResult" },
    ],
    logger: new ConsoleLogger({ level: "info" }),
});

console.log(
    `Extracted ${result.events.length} events, ` +
        `${result.commands.length} commands, ` +
        `${result.publicContracts.length} public contracts`
);
```

For fine-grained control, use the `ContractsPipeline` class which provides step-by-step execution: `scan()`, `parse()`, `resolve()`, `copy()`, and `exportBarrel()`.

### Output Structure

The generated contracts package follows this structure:

```
contracts/
├── src/
│   ├── {context}/
│   │   ├── events.ts
│   │   ├── commands.ts
│   │   ├── queries.ts
│   │   ├── types.ts       # Dependent types + Response types
│   │   └── index.ts       # Barrel exports
│   └── index.ts           # Namespace exports + MessageRegistry for messages
├── package.json
└── tsconfig.json
```

The root `index.ts` uses namespace exports to prevent name collisions:

```typescript
// contracts/src/index.ts
import { MessageRegistry } from "@hexaijs/plugin-contracts-generator/runtime";

export * as order from "./order";
export * as inventory from "./inventory";

export const messageRegistry = new MessageRegistry()
    .register(order.OrderPlaced)
    .register(inventory.StockUpdated);
```

Only decorated events, commands, and queries are registered. General contracts marked with `@Contract(...)` comments are exported through the generated package but are not registered.

Use namespace exports in your frontend:

```typescript
import { order, messageRegistry } from "@myorg/contracts";

// Access types via namespace
const event = new order.OrderPlaced({ orderId: "123", customerId: "456" });

// Deserialize messages from the backend
const message = messageRegistry.dehydrate(header, body);
```

## Error Handling

The generator provides specific error types for different failure modes:

```typescript
import {
    processContext,
    MessageParserError,
    FileReadError,
    ConfigLoadError,
} from "@hexaijs/plugin-contracts-generator";

try {
    await processContext(options);
} catch (error) {
    if (error instanceof FileReadError) {
        console.error(`Failed to read: ${error.path}`, error.cause);
    } else if (error instanceof ConfigLoadError) {
        console.error(`Config error: ${error.message}`);
    } else if (error instanceof MessageParserError) {
        console.error(`Parser error: ${error.message}`);
    }
}
```

**Error hierarchy:**

- `MessageParserError` (base)
  - `BoundaryViolationError`
  - `ConfigurationError` → `ConfigLoadError`
  - `FileSystemError` → `FileNotFoundError`, `FileReadError`, `FileWriteError`
  - `ParseError` → `JsonParseError`
  - `ResolutionError` → `ModuleResolutionError`

## API Highlights

| Export | Description |
|--------|-------------|
| `processContext(options)` | Main API for extracting and copying contracts |
| `ContractsPipeline` | Fine-grained control over extraction process |
| `ContractEvent` | Decorator to mark event messages for extraction and registry generation |
| `ContractCommand` | Decorator to mark command messages for extraction and registry generation |
| `ContractQuery` | Decorator to mark query messages for extraction and registry generation |
| `Contract` | Generic decorator for message and non-message contract roles through `kind` |
| `PublicEvent`, `PublicCommand`, `PublicQuery`, `PublicContract` | Deprecated compatibility aliases for the canonical `Contract*` API; no runtime warnings |
| `ContractDeclaration` | Canonical domain model for selected message and general contract declarations |
| `PublicContract` type | Compatibility domain model for marked `class`, `interface`, `type`, and `enum` declarations |
| `ContractOutputConfig` | `outputs[]` configuration shape for output-level path, selector, and registry settings |
| `ContractMarkerNames` | Configuration shape for customizing legacy public contract comment marker names |
| `EntryStrategy` | `symbols` for default strict declaration extraction, or `graph` for entry file graph copy |
| `MessageRegistry` | Runtime registry for decorated message deserialization |
| `ConsoleLogger` | Configurable logger for build output |
| Error types | `ConfigLoadError`, `FileReadError`, `MessageParserError`, etc. |

## Known Limitations

- `entryStrategy: "graph"` may copy unselected declarations from selected entry files because it treats selected files as graph roots. Use the default `symbols` strategy for strict public/internal splits.
- Generation failures are not fully atomic yet and may leave partial selected output after `BoundaryViolationError`.
- Decorator namespace imports such as `Contracts.ContractCommand` are not matched.
- Automatic multi-hop tracing through arbitrary local re-export chains is intentionally not automatic. Use direct named imports from trusted contract packages or a trusted integration configuration.

## See Also

- [@hexaijs/core](../core/README.md) - DomainEvent and Message base classes used by contracts
- [@hexaijs/plugin-application-builder](../plugin-application-builder/README.md) - Companion plugin for handler registration
