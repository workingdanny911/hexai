# @hexaijs/plugin-application-builder

> Build plugin for generating ApplicationBuilder code from decorated handlers

## Overview

`@hexaijs/plugin-application-builder` eliminates the boilerplate of manually registering every handler with `ApplicationBuilder`. Instead of maintaining a growing list of `.withCommandHandler()` and `.withEventHandler()` calls, you decorate your handler classes and let the build tool generate the registration code automatically.

The plugin works at build time by:

1. Scanning your TypeScript files for handler classes decorated with marker decorators
2. Extracting metadata using TypeScript's AST (Abstract Syntax Tree) parser
3. Generating a `createApplicationBuilder()` function with all handlers properly registered

This approach keeps your handler files self-documenting (the decorator shows what type of handler it is) while centralizing the wiring in a generated file that stays in sync automatically.

## Installation

```bash
npm install @hexaijs/plugin-application-builder
```

**Peer dependencies:**
- `@hexaijs/core`
- `@hexaijs/application`
- `typescript ^5.0.0`

## Core Concepts

### Marker Decorators

The package provides three decorators that serve as markers for the code generator. These decorators have **no runtime behavior** - they simply tag classes for discovery during the build process.

```typescript
import {
    CommandHandlerMarker,
    QueryHandlerMarker,
    EventHandlerMarker
} from "@hexaijs/plugin-application-builder";
```

**CommandHandlerMarker** - Marks a class as a command handler and links it to its request type:

```typescript
import { CommandHandlerMarker } from "@hexaijs/plugin-application-builder";
import { CreateOrderRequest } from "./request";

@CommandHandlerMarker(CreateOrderRequest)
export class CreateOrderHandler extends BaseHandler<
    CreateOrderRequest,
    CreateOrderResponse,
    OrderApplicationContext
> {
    protected async doExecute(
        request: CreateOrderRequest,
        ctx: OrderApplicationContext
    ): Promise<CreateOrderResponse> {
        // Implementation
    }
}
```

**QueryHandlerMarker** - Marks a class as a query handler:

```typescript
import { QueryHandlerMarker } from "@hexaijs/plugin-application-builder";
import { GetOrderQuery } from "./query";

@QueryHandlerMarker(GetOrderQuery)
export class GetOrderHandler extends BaseHandler<
    GetOrderQuery,
    OrderDto,
    OrderApplicationContext
> {
    protected async doExecute(
        query: GetOrderQuery,
        ctx: OrderApplicationContext
    ): Promise<OrderDto> {
        // Implementation
    }
}
```

**EventHandlerMarker** - Marks a class as an event handler:

```typescript
import { Message } from "@hexaijs/core";
import { EventHandlerMarker } from "@hexaijs/plugin-application-builder";

@EventHandlerMarker()
export class HandleOrderPlaced extends BaseEventHandler<OrderApplicationContext> {
    canHandle(message: Message): message is OrderPlaced {
        return message.getMessageType() === OrderPlaced.getType();
    }

    async handle(
        event: OrderPlaced,
        ctx: OrderApplicationContext
    ): Promise<void> {
        const payload = event.getPayload();
        // React to event
    }
}
```

For event handlers that need a unique identifier (useful for idempotency tracking), provide a `name` option:

```typescript
@EventHandlerMarker({ name: "send-order-confirmation" })
export class SendOrderConfirmationEmail extends BaseEventHandler<OrderApplicationContext> {
    // ...
}
```

### Configuration

Create an `application.config.ts` file in your package root:

```typescript
import { RawBuildPluginConfig } from "@hexaijs/plugin-application-builder";

const config: RawBuildPluginConfig = {
    // Glob patterns to find handler files
    handlers: [
        "src/commands/**/*.ts",
        "src/queries/**/*.ts",
        "src/event-handlers/**/*.ts"
    ],

    // Import path for ApplicationBuilder in generated code
    applicationBuilderImportPath: "@/application-builder",

    // Output file path (optional, defaults to "src/.generated/application-builder.ts")
    outputFile: "src/.generated/application-builder.ts"
};

export default config;
```

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `handlers` | Yes | - | Glob patterns for files containing decorated handlers |
| `applicationBuilderImportPath` | Yes | - | Import path for your `ApplicationBuilder` class |
| `outputFile` | No | `src/.generated/application-builder.ts` | Where to write the generated code |

### Code Generation

Run the generator using the CLI:

```bash
npx generate-app-builder
```

Or specify a custom path:

```bash
npx generate-app-builder --context-path ./packages/my-bounded-context
```

The generator produces a file like:

```typescript
// src/.generated/application-builder.ts (auto-generated)
import { ApplicationBuilder } from '@/application-builder';
import { CreateOrderHandler } from '../commands/create-order/handler';
import { CreateOrderRequest } from '../commands/create-order/request';
import { GetOrderHandler } from '../queries/get-order/handler';
import { GetOrderQuery } from '../queries/get-order/query';
import { HandleOrderPlaced } from '../event-handlers/handle-order-placed';

export function createApplicationBuilder(): ApplicationBuilder {
  return new ApplicationBuilder()
    .withCommandHandler(CreateOrderRequest, () => new CreateOrderHandler())
    .withQueryHandler(GetOrderQuery, () => new GetOrderHandler())
    .withEventHandler(() => new HandleOrderPlaced());
}
```

### Programmatic API

For custom build scripts, use the `generateApplicationBuilder` function:

```typescript
import { generateApplicationBuilder } from "@hexaijs/plugin-application-builder";

await generateApplicationBuilder("./packages/order", {
    configFile: "application.config.ts"  // optional
});
```

## Usage

### Integrating into Your Build

Add the generator to your build scripts:

```json
{
  "scripts": {
    "prebuild": "generate-app-builder",
    "build": "tsc"
  }
}
```

This ensures the generated file is always up-to-date before compilation.

### Using the Generated Builder

Import and use the generated function in your application setup:

```typescript
import { createApplicationBuilder } from "./.generated/application-builder";

// The generated builder has all handlers registered
const builder = createApplicationBuilder();

// Add your application context and build
const application = builder
    .withApplicationContext(new OrderApplicationContext())
    .build();
```

### Path Alias Support

The generator respects TypeScript path aliases defined in your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  }
}
```

When handlers import request classes using aliases (e.g., `import { CreateOrderRequest } from "@/commands/create-order/request"`), the generator correctly resolves these paths.

## Error Handling

The generator validates your configuration and throws descriptive errors:

**DuplicateCommandHandlerError** - Thrown when multiple handlers are registered for the same command:

```
Duplicate command handlers for "CreateOrderRequest": CreateOrderHandler, AnotherCreateOrderHandler
```

**DuplicateQueryHandlerError** - Thrown when multiple handlers are registered for the same query.

**DuplicateEventHandlerError** - Thrown when multiple event handlers share the same `name` option.

**MessageClassNotFoundError** - Thrown when a decorator references a class that cannot be found:

```
Cannot find "CreateOrderRequest" - not imported and not defined in "src/commands/create-order/handler.ts"
```

## API Highlights

| Export | Description |
|--------|-------------|
| `generateApplicationBuilder(path, options?)` | Programmatic API to run code generation |
| `CommandHandlerMarker` | Decorator to mark command handlers |
| `QueryHandlerMarker` | Decorator to mark query handlers |
| `EventHandlerMarker` | Decorator to mark event handlers |
| `EventHandlerOptions` | Type for event handler decorator options |
| `DuplicateCommandHandlerError` | Error for duplicate command handler registration |
| `DuplicateQueryHandlerError` | Error for duplicate query handler registration |
| `DuplicateEventHandlerError` | Error for duplicate event handler registration |
| `HandlerMetadataExtractor` | Class for extracting handler metadata from TypeScript files |

## See Also

- [@hexaijs/application](../application/README.md) - The ApplicationBuilder this plugin generates code for
- [@hexaijs/core](../core/README.md) - Core domain primitives used by handlers
