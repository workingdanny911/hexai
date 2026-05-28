# @hexaijs/plugin-contracts-generator

> Extract public message contracts and general TypeScript contracts from backend source code to generate frontend-compatible types

## Overview

`@hexaijs/plugin-contracts-generator` solves the problem of keeping frontend and backend type definitions in sync. In a hexagonal architecture, your backend defines domain events, commands, queries, and shared public contracts - but your frontend also needs type-safe access to these message types and general contract declarations for API calls, event handling, and validation.

Instead of manually duplicating type definitions (which inevitably drift out of sync), this plugin scans your backend source code for public message decorators and comment-based public contract markers, then extracts the matching declarations into a standalone contracts package. The generated package contains only the public API surface - message types, their payloads, response types, and explicitly marked general contracts - without backend implementation details.

The plugin works at build time by:

1. Scanning TypeScript files for message classes decorated with `@PublicEvent()`, `@PublicCommand()`, or `@PublicQuery()`, plus declarations with a leading `@PublicContract()` comment marker
2. Resolving all type dependencies (including response types, shared value objects, and general contract declarations)
3. Generating a clean contracts package with namespace exports and, when requested, a MessageRegistry for decorated messages only

## Installation

```bash
npm install @hexaijs/plugin-contracts-generator
```

**Peer dependencies:**
- `typescript ^5.0.0`

## Core Concepts

### Message Decorators

The package provides three decorators that mark messages for extraction. These decorators have **no runtime overhead** - they simply tag classes for discovery during the build process. Decorated messages are the only generated contracts registered in `MessageRegistry`.

```typescript
import { PublicEvent, PublicCommand, PublicQuery } from "@hexaijs/contracts/decorators";
```

**@PublicEvent()** - Marks a domain event as part of the public contract:

```typescript
import { DomainEvent } from "@hexaijs/core";
import { PublicEvent } from "@hexaijs/contracts/decorators";

@PublicEvent()
export class OrderPlaced extends DomainEvent<{
    orderId: string;
    customerId: string;
    totalAmount: number;
}> {
    static readonly type = "order.order-placed";
}
```

**@PublicCommand()** - Marks a command as part of the public contract:

```typescript
import { PublicCommand } from "@hexaijs/contracts/decorators";

@PublicCommand()
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

**@PublicQuery()** - Marks a query as part of the public contract:

```typescript
import { PublicQuery } from "@hexaijs/contracts/decorators";

@PublicQuery({ response: "OrderDetails" })
export class GetOrderQuery extends BaseRequest<{
    orderId: string;
}> {}

type OrderDetails = {
    orderId: string;
    status: string;
    items: OrderItem[];
};
```

Each decorator accepts optional configuration:
- `context` - Override the context name for this message
- `version` - Specify a version number for versioned events
- `response` - Explicitly name the response type (for commands/queries)

### PublicContract Comment Marker

General contracts that are not messages use a TypeScript leading comment marker instead of a decorator. The marker can be a line comment or a JSDoc block placed immediately before a `class`, `interface`, `type`, or `enum` declaration. If the marked declaration is not exported in the source file, the generator adds `export` in the generated contracts output.

```typescript
// @PublicContract()
interface OrderSnapshot {
    orderId: string;
    status: OrderStatus;
    totalAmount: number;
}

/** @PublicContract() */
type OrderStatus = "draft" | "placed" | "cancelled";
```

`@PublicContract()` is a comment marker, not a runtime decorator. Do not write it as decorator syntax:

```typescript
// Unsupported: TypeScript decorators cannot be applied to interfaces or type aliases.
@PublicContract()
export interface OrderSnapshot {
    orderId: string;
}
```

Comment-marked public contracts are included in the generated contracts output, but they are not message contracts and are never registered in `MessageRegistry`.

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

        // Response type naming conventions (optional)
        responseNamingConventions: [
            { messageSuffix: "Command", responseSuffix: "CommandResult" },
            { messageSuffix: "Query", responseSuffix: "QueryResult" },
            { messageSuffix: "Request", responseSuffix: "Response" },
        ],

        // Custom decorator names (optional, defaults shown)
        decoratorNames: {
            event: "PublicEvent",
            command: "PublicCommand",
            query: "PublicQuery",
        },

        // Custom comment marker names for general contracts (optional, defaults shown)
        contractMarkerNames: {
            contract: "PublicContract",
        },

        // Strip decorators from generated output (optional, default: true)
        removeDecorators: true,
    },
};
```

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

### Response Types

Commands and queries often have associated response types. The generator includes these in the contracts package automatically.

**Automatic detection via naming conventions:**

```typescript
// When responseNamingConventions includes { messageSuffix: "Command", responseSuffix: "CommandResult" }

@PublicCommand()
export class CreateOrderCommand extends Message<{ customerId: string }> {}

type CreateOrderCommandResult = {  // Automatically detected by naming pattern
    orderId: string;
};
```

**Explicit response option:**

```typescript
@PublicCommand({ response: "OrderCreationResult" })
export class CreateOrder extends Message<{ customerId: string }> {}

type OrderCreationResult = {
    orderId: string;
    createdAt: Date;
};
```

Response types must be in the same file as the command/query. Both `type` aliases and `interface` declarations are supported. The generator adds `export` automatically if the type isn't already exported.

### Entry vs Dependency Files

The generator handles two types of files differently:

**Entry files** (files with message decorators or `@PublicContract()` comment markers) are contract entry points:
- Default message generation preserves message entry files and their runtime dependencies
- Message filters (`--messages`, `--message-types`) extract only matching decorated message classes
- PublicContract-only files extract comment-marked `class`, `interface`, `type`, and `enum` declarations
- Handler classes and unused imports are excluded in extraction modes
- Response types are included based on naming conventions

**Dependency files** (imported by entry files) are copied entirely:
- Supports barrel files (`export * from './module'`)
- Preserves all exports for transitive dependencies
- Ensures type dependencies remain intact

## Usage

### CLI

Run the generator from your monorepo root:

```bash
# Required: --output-dir (-o) specifies where contracts are generated
npx generate-contracts --output-dir packages/contracts/src

# Specify config file path (default: application.config.ts)
npx generate-contracts -o packages/contracts/src --config ./app.config.ts
```

By default, the CLI uses `--include all` and `--messages event,command,query`. This generates decorated `@PublicEvent()`, `@PublicCommand()`, and `@PublicQuery()` message contracts plus comment-marked `@PublicContract()` declarations.

| Option | Description |
|--------|-------------|
| `-o, --output-dir <path>` | Required output directory for the generated contracts package |
| `-c, --config <path>` | Config file path (default: `application.config.ts`) |
| `--include <scope>` | Select generated contract categories: `all`, `messages`, or `contracts` |
| `--messages <types>` | Recommended message subtype filter. Accepts comma-separated `event`, `command`, and `query` values |
| `-m, --message-types <types>` | Legacy alias for `--messages`; kept for backwards compatibility |
| `--registry` | Generate the root `MessageRegistry` export |
| `--generate-message-registry` | Legacy verbose alias for `--registry` |
| `--dry-run` | Print the planned context extraction and file summary without writing files |
| `--check` | Verify generated output freshness for CI and exit non-zero when changes are required |

`--include contracts` generates only `@PublicContract()` declarations. `--include messages` generates only decorated messages. `--messages` filters only the message subtypes and does not exclude `@PublicContract()` declarations when `--include all` is used. The generated `MessageRegistry` registers messages only; general public contracts are never registered.

Common workflows:

```bash
# Preview the plan, then generate contracts with a MessageRegistry
npx generate-contracts -o packages/contracts/src --dry-run
npx generate-contracts -o packages/contracts/src --registry

# Generate messages only
npx generate-contracts -o packages/contracts/src --include messages --messages event,command

# Generate general public contracts only
npx generate-contracts -o packages/contracts/src --include contracts

# CI freshness check
npx generate-contracts -o packages/contracts/src --check
```

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

Only decorated events, commands, and queries are registered. General contracts marked with `@PublicContract()` comments are exported through the generated package but are not registered.

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
  - `ConfigurationError` → `ConfigLoadError`
  - `FileSystemError` → `FileNotFoundError`, `FileReadError`, `FileWriteError`
  - `ParseError` → `JsonParseError`
  - `ResolutionError` → `ModuleResolutionError`

## API Highlights

| Export | Description |
|--------|-------------|
| `processContext(options)` | Main API for extracting and copying contracts |
| `ContractsPipeline` | Fine-grained control over extraction process |
| `PublicEvent` | Decorator to mark event messages for extraction and registry generation |
| `PublicCommand` | Decorator to mark command messages for extraction and registry generation |
| `PublicQuery` | Decorator to mark query messages for extraction and registry generation |
| `PublicContract` marker | Comment marker (`// @PublicContract()` or JSDoc) for general contracts; not a decorator export |
| `PublicContract` type | Domain model for comment-marked `class`, `interface`, `type`, and `enum` declarations |
| `ContractMarkerNames` | Configuration shape for customizing public contract comment marker names |
| `MessageRegistry` | Runtime registry for decorated message deserialization |
| `ConsoleLogger` | Configurable logger for build output |
| Error types | `ConfigLoadError`, `FileReadError`, `MessageParserError`, etc. |

## See Also

- [@hexaijs/core](../core/README.md) - DomainEvent and Message base classes used by contracts
- [@hexaijs/plugin-application-builder](../plugin-application-builder/README.md) - Companion plugin for handler registration
