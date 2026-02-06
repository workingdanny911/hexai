# @hexaijs/plugin-contracts-generator

> Extract Domain Events, Commands, and Queries from backend source code to generate frontend-compatible contract types

## Overview

`@hexaijs/plugin-contracts-generator` solves the problem of keeping frontend and backend type definitions in sync. In a hexagonal architecture, your backend defines domain events, commands, and queries - but your frontend also needs type-safe access to these message types for API calls, event handling, and validation.

Instead of manually duplicating type definitions (which inevitably drift out of sync), this plugin scans your backend source code for specially decorated classes and extracts them into a standalone contracts package. The generated package contains only the public API surface - the message types and their payloads - without any backend implementation details.

The plugin works at build time by:

1. Scanning TypeScript files for classes decorated with `@PublicEvent()`, `@PublicCommand()`, or `@PublicQuery()`
2. Resolving all type dependencies (including response types and shared value objects)
3. Generating a clean contracts package with namespace exports and a MessageRegistry for deserialization

## Installation

```bash
npm install @hexaijs/plugin-contracts-generator
```

**Peer dependencies:**
- `typescript ^5.0.0`

## Core Concepts

### Decorators

The package provides three decorators that mark messages for extraction. These decorators have **no runtime overhead** - they simply tag classes for discovery during the build process.

```typescript
import { PublicEvent, PublicCommand, PublicQuery } from "@hexaijs/plugin-contracts-generator/decorators";
```

**@PublicEvent()** - Marks a domain event as part of the public contract:

```typescript
import { DomainEvent } from "@hexaijs/core";
import { PublicEvent } from "@hexaijs/plugin-contracts-generator/decorators";

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
import { PublicCommand } from "@hexaijs/plugin-contracts-generator/decorators";

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
import { PublicQuery } from "@hexaijs/plugin-contracts-generator/decorators";

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

**Entry files** (files with `@Public*` decorators) undergo symbol extraction:
- Only decorated classes matching the specified message types are extracted
- Handler classes are excluded
- Response types are included based on naming conventions
- Unused imports are removed

**Dependency files** (imported by entry files) are copied entirely:
- Supports barrel files (`export * from './module'`)
- Preserves all exports for transitive dependencies
- Ensures type dependencies remain intact

## Usage

### CLI

Run the generator from your monorepo root:

```bash
# Required: --output-dir (-o) specifies where contracts are generated
npx contracts-generator --output-dir packages/contracts/src

# Specify config file path (default: application.config.ts)
npx contracts-generator -o packages/contracts/src --config ./app.config.ts

# Filter by message types
npx contracts-generator -o packages/contracts/src -m event           # Extract only events
npx contracts-generator -o packages/contracts/src -m command         # Extract only commands
npx contracts-generator -o packages/contracts/src -m event,command   # Extract events and commands

# Generate with message registry (index.ts)
npx contracts-generator -o packages/contracts/src --generate-message-registry
```

### Programmatic API

For custom build scripts:

```typescript
import { processContext, ConsoleLogger } from "@hexaijs/plugin-contracts-generator";

const result = await processContext({
    contextName: "order",
    sourceDir: "packages/order/src",
    outputDir: "packages/contracts/src",
    pathAliasRewrites: new Map([["@myorg/", "@/"]]),
    messageTypes: ["event", "command"],
    responseNamingConventions: [
        { messageSuffix: "Command", responseSuffix: "CommandResult" },
    ],
    logger: new ConsoleLogger({ level: "info" }),
});

console.log(`Extracted ${result.events.length} events, ${result.commands.length} commands`);
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
│   └── index.ts           # Namespace exports + MessageRegistry
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
| `PublicEvent` | Decorator to mark events for extraction |
| `PublicCommand` | Decorator to mark commands for extraction |
| `PublicQuery` | Decorator to mark queries for extraction |
| `MessageRegistry` | Runtime registry for message deserialization |
| `ConsoleLogger` | Configurable logger for build output |
| Error types | `ConfigLoadError`, `FileReadError`, `MessageParserError`, etc. |

## See Also

- [@hexaijs/core](../core/README.md) - DomainEvent and Message base classes used by contracts
- [@hexaijs/plugin-application-builder](../plugin-application-builder/README.md) - Companion plugin for handler registration
