# @hexaijs/plugin-application-builder

> Build plugin for generating ApplicationBuilder code from decorated handlers

An `ApplicationBuilder` from [`@hexaijs/application`](../application/README.md) builds an application from registered handlers: you call `.withCommandHandler()`, `.withQueryHandler()` and `.withEventHandler()` once per handler. A handler is the class that executes one command or query, or reacts to events. This plugin writes those calls for you. You mark each handler class with a decorator, and the generator scans your handler files and writes a `createApplicationBuilder()` function that registers every marked handler. The decorators do nothing at runtime; the generator reads them from the TypeScript source.

Use it when a bounded context has enough handlers that keeping the registration list by hand becomes a chore. A bounded context here is one package of your system with its own handlers, for example `packages/orders`.

## Installation

```bash
npm install @hexaijs/plugin-application-builder
```

| Peer dependency | Used for |
|-----------------|----------|
| `@hexaijs/core` | Parameter types of the marker decorators |
| `@hexaijs/application` | The `ApplicationBuilder` that the generated code registers handlers with |
| `@hexaijs/cli` | The `hexai generate-app-builder` command |
| `typescript` | Reading handler files and the context config |

The supported versions are the `peerDependencies` ranges in `package.json`.

## Quick Start

This example uses a bounded context in `packages/orders`.

1. Create the context config, `packages/orders/hexai.config.ts`:

    ```typescript
    import type { RawBuildPluginConfig } from "@hexaijs/plugin-application-builder";

    const config: RawBuildPluginConfig = {
        handlers: ["src/**/*.handler.ts"],
        applicationBuilderImportPath: "@hexaijs/application",
    };

    export default config;
    ```

2. Mark a handler, `packages/orders/src/create-order.handler.ts`:

    ```typescript
    import type { CommandHandler } from "@hexaijs/application";
    import { CommandHandlerMarker } from "@hexaijs/plugin-application-builder";

    import {
        CreateOrderCommand,
        type CreateOrderResult,
    } from "./create-order.command.js";

    @CommandHandlerMarker(CreateOrderCommand)
    export class CreateOrderHandler implements CommandHandler<CreateOrderCommand> {
        async execute(command: CreateOrderCommand): Promise<CreateOrderResult> {
            return { orderId: `order-of-${command.getPayload().customerId}` };
        }
    }
    ```

    `CreateOrderCommand` is an ordinary command class:

    ```typescript
    import { Command } from "@hexaijs/application";

    export type CreateOrderResult = { orderId: string };

    export class CreateOrderCommand extends Command<
        { customerId: string },
        CreateOrderResult
    > {
        static readonly type = "orders.create-order";
    }
    ```

3. Generate the builder:

    ```bash
    npx generate-app-builder --context-path packages/orders
    ```

    This writes `packages/orders/src/.generated/application-builder.ts`:

    ```typescript
    import { ApplicationBuilder } from '@hexaijs/application';
    import { CreateOrderHandler } from '../create-order.handler.js';
    import { CreateOrderCommand } from '../create-order.command.js';

    export function createApplicationBuilder(): ApplicationBuilder {
      return new ApplicationBuilder()
        .withCommandHandler(CreateOrderCommand, () => new CreateOrderHandler());
    }
    ```

4. Build the application from the generated builder:

    ```typescript
    import { createApplicationBuilder } from "./.generated/application-builder.js";

    const application = createApplicationBuilder()
        .withApplicationContext({})
        .build();
    ```

    `withApplicationContext()` takes your application context, the object handlers receive as their second argument. See [@hexaijs/application](../application/README.md) for what to put in it and how to execute commands.

Run the generator again whenever you add, remove or rename a handler.

## Marker Decorators

Import the decorators from `@hexaijs/plugin-application-builder` or `@hexaijs/plugin-application-builder/decorators`.

| Decorator | Put it on | Generated registration |
|-----------|-----------|------------------------|
| `@CommandHandlerMarker(CommandClass)` | A command handler | `.withCommandHandler(CommandClass, () => new Handler())` |
| `@QueryHandlerMarker(QueryClass)` | A query handler | `.withQueryHandler(QueryClass, () => new Handler())` |
| `@EventHandlerMarker(options?)` | An event handler | `.withEventHandler(() => new Handler())`, plus the name when `options.name` is set |

A query handler looks like a command handler:

```typescript
import type { QueryHandler } from "@hexaijs/application";
import { QueryHandlerMarker } from "@hexaijs/plugin-application-builder";

import { GetOrderQuery, type OrderSummary } from "./get-order.query.js";

@QueryHandlerMarker(GetOrderQuery)
export class GetOrderHandler implements QueryHandler<GetOrderQuery> {
    async execute(query: GetOrderQuery): Promise<OrderSummary> {
        return { orderId: query.getPayload().orderId, status: "placed" };
    }
}
```

An event handler takes no message class. It decides in `canHandle()` which events it handles:

```typescript
import type { EventHandler } from "@hexaijs/application";
import type { Message } from "@hexaijs/core";
import { EventHandlerMarker } from "@hexaijs/plugin-application-builder";

import { OrderPlaced } from "./order-placed.js";

@EventHandlerMarker({ name: "send-order-confirmation" })
export class SendOrderConfirmation implements EventHandler<OrderPlaced> {
    canHandle(message: Message): boolean {
        return message.getMessageType() === OrderPlaced.getType();
    }

    async handle(event: OrderPlaced): Promise<void> {
        console.log(`Order placed: ${event.getPayload().orderId}`);
    }
}
```

`name` is the only option `@EventHandlerMarker` accepts. It gives the handler a unique name: the generator and `ApplicationBuilder` both reject two event handlers with the same name. The generated registration passes the name as the second argument: `.withEventHandler(() => new SendOrderConfirmation(), 'send-order-confirmation')`.

### What the generator expects

The generator reads source text; it does not run or type-check your code. A handler is found only when:

- its file matches one of the `handlers` patterns;
- it is a top-level class declaration;
- the decorator is called with parentheses under its own name (`@CommandHandlerMarker(...)`, not an alias);
- the command or query class in the decorator is declared in the same file, or imported with a named import from a relative path or a `tsconfig.json` path alias. An import from a package name produces a broken import path in the generated file.

The generated file imports each handler and each command or query class by name, so export them from their files.

The generated code creates every handler with `new Handler()`, without arguments. Give handlers what they need through the application context instead of the constructor.

## Context Configuration

Each bounded context has its own config file, `hexai.config.ts` in the context root by default. It exports a `RawBuildPluginConfig` object as its default export:

```typescript
import type { RawBuildPluginConfig } from "@hexaijs/plugin-application-builder";

const config: RawBuildPluginConfig = {
    handlers: ["src/commands/**/*.ts", "src/queries/**/*.ts", "src/event-handlers/**/*.ts"],
    applicationBuilderImportPath: "../application-builder.js",
    outputFile: "src/.generated/application-builder.ts",
    outputModuleSpecifiers: "js",
};

export default config;
```

Here the context's own `src/application-builder.ts` exports the `ApplicationBuilder` class, and the import path starts from the generated file in `src/.generated/`.

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `handlers` | Yes | | Glob patterns, relative to the context root, for the files that contain handlers. Must not be empty. |
| `applicationBuilderImportPath` | Yes | | Module the generated file imports `ApplicationBuilder` from: `"@hexaijs/application"` or your own module that exports a class named `ApplicationBuilder`. The generator copies this specifier into the generated file and only adjusts the extension of a relative path to the import style, so a relative path must start from the generated file. |
| `outputFile` | No | `src/.generated/application-builder.ts` | Where to write the generated code, relative to the context root |
| `outputModuleSpecifiers` | No | `"js"` | Style of relative imports in the generated file: `"js"` adds `.js` extensions, as NodeNext and native ESM require; `"extensionless"` leaves them off for older bundler setups |

The generator compiles this file with TypeScript and evaluates it on its own. Keep it a plain object; type-only imports are fine, but value imports would resolve from the plugin's install location rather than from your context.

This file shares its default name with the `hexai` CLI config, but it is a different file: the CLI config at your project root lists plugins, and this one configures one bounded context. Run `hexai` from the project root so the CLI does not pick up a context config by mistake.

### Path aliases

When a handler imports its command or query through a path alias, the generator resolves the alias with `compilerOptions.paths` and `compilerOptions.baseUrl` from the context's own `tsconfig.json`, and writes a relative import into the generated file:

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

The generator reads only `<context>/tsconfig.json` itself; it does not follow `extends`. `baseUrl` defaults to the context root.

## Running the Generator

### `generate-app-builder` command

The package installs a `generate-app-builder` command:

```bash
npx generate-app-builder --context-path packages/orders
npx generate-app-builder --context-path packages/orders --output-module-specifiers extensionless
```

| Option | Description |
|--------|-------------|
| `--context-path <path>` | Bounded context root. Defaults to the current directory. |
| `--output-module-specifiers <style>` | `js` or `extensionless`. Overrides the context config. |

This command always reads `hexai.config.ts`. To use another file name, use the `hexai` command or the programmatic API.

To regenerate before every build, run it from the context's `package.json`. The context path then defaults to the package directory:

```json
{
    "scripts": {
        "prebuild": "generate-app-builder",
        "build": "tsc"
    }
}
```

### `hexai generate-app-builder` command

With [`@hexaijs/cli`](../cli/README.md), register the plugin in the CLI config at your project root:

```typescript
import type { HexaiConfig } from "@hexaijs/cli";

export default {
    plugins: [
        {
            plugin: "@hexaijs/plugin-application-builder",
            config: {
                outputModuleSpecifiers: "js",
            },
        },
    ],
} satisfies HexaiConfig;
```

```bash
pnpm hexai generate-app-builder --context-path packages/orders
```

| Option | Description |
|--------|-------------|
| `-p, --context-path <path>` | Required. Bounded context root, relative to the current directory. |
| `-f, --config-file <name>` | Context config file name. Defaults to `hexai.config.ts`. |
| `--output-module-specifiers <style>` | `js` or `extensionless` |

The plugin's `config` in the CLI config accepts the same two settings as defaults for every context:

| Plugin config | Description |
|---------------|-------------|
| `configFile` | Context config file name, used when `--config-file` is not given |
| `outputModuleSpecifiers` | Import style, used when `--output-module-specifiers` is not given |

For the import style, the command-line option wins over the plugin config, the plugin config wins over the context config, and `"js"` applies when none sets it.

### Programmatic API

```typescript
import { generateApplicationBuilder } from "@hexaijs/plugin-application-builder";

await generateApplicationBuilder("packages/orders", {
    configFile: "hexai.config.ts",
    outputModuleSpecifiers: "js",
});
```

Both options are optional. `configFile` defaults to `"hexai.config.ts"`. `outputModuleSpecifiers` overrides the context config, which defaults to `"js"`.

## Errors

The generator stops and writes nothing when it finds one of these problems:

| Error | When | Message |
|-------|------|---------|
| `DuplicateCommandHandlerError` | Two handlers are marked for the same command class | `Duplicate command handlers for "CreateOrderCommand": CreateOrderHandler, AnotherCreateOrderHandler` |
| `DuplicateQueryHandlerError` | Two handlers are marked for the same query class | `Duplicate query handlers for "<query>": <handlers>` |
| `DuplicateEventHandlerError` | Two event handlers share a `name` | `Duplicate event handlers for event "<name>": <handlers>` |
| `MessageClassNotFoundError` | The class in a marker is neither imported nor declared in the handler's file | `Cannot find "CreateOrderCommand" - not imported and not defined in "<file>"` |
| `Error` | The context config misses `applicationBuilderImportPath` or `handlers`, has an unknown `outputModuleSpecifiers` value, or an `@EventHandlerMarker` has options other than `name` | A message naming the problem |

The package exports the three `Duplicate*Error` classes. `MessageClassNotFoundError` is not exported; check its `name` property if you need to tell it apart.

## API Reference

| Export | Description |
|--------|-------------|
| `CommandHandlerMarker`, `QueryHandlerMarker`, `EventHandlerMarker` | Marker decorators, also exported from `./decorators` |
| `EventHandlerOptions` | Options type of `EventHandlerMarker` |
| `generateApplicationBuilder(contextPath, options?)` | Runs the generator for one bounded context |
| `GenerateApplicationBuilderOptions` | Options type of `generateApplicationBuilder` |
| `RawBuildPluginConfig` | Type of the context config file |
| `BuildPluginConfig` | Validated context config with defaults applied; `BuildPluginConfig.fromRawConfig(raw)` creates one |
| `OutputModuleSpecifiers` | `"js" \| "extensionless"` |
| `cliPlugin`, `ApplicationBuilderPluginConfig` | The `hexai` CLI plugin and its config type |
| `DuplicateCommandHandlerError`, `DuplicateQueryHandlerError`, `DuplicateEventHandlerError` | Errors for duplicate registrations |

## See Also

- [@hexaijs/application](../application/README.md): `ApplicationBuilder`, handlers and the application context
- [@hexaijs/cli](../cli/README.md): the `hexai` command
- [@hexaijs/contracts](../contracts/README.md): `Command` and `Query` base classes
