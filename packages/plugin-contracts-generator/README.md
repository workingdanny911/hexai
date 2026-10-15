# @hexaijs/plugin-contracts-generator

A build-time tool that copies the contracts of your backend into a separate TypeScript package that a frontend can import. You mark the commands, queries and events that clients may use, plus any other types they need; the generator copies those declarations and the local types they depend on, and leaves handlers, repositories and other backend code behind. Use it when a TypeScript client must share exact payload, response and event types with a hexai backend without re-declaring them by hand.

## Installation

```bash
npm install --save-dev @hexaijs/plugin-contracts-generator typescript
npm install @hexaijs/contracts
```

| Package | Why you need it |
|---------|-----------------|
| `typescript` | Required peer dependency. The generator reads your source with the TypeScript compiler API. |
| `@hexaijs/cli` | Optional peer dependency. Install it only to run the generator as `hexai generate-contracts` (see [Run as a hexai CLI plugin](#run-as-a-hexai-cli-plugin)). |
| `@hexaijs/contracts` | Provides the marker decorators and the `Command` and `Query` base classes your backend imports. The generator already depends on it; add it to every backend package that imports it. See the [`@hexaijs/contracts` README](../contracts/README.md). |

The package has two entry points and one binary:

- `@hexaijs/plugin-contracts-generator`: the programmatic API (build time only).
- `@hexaijs/plugin-contracts-generator/runtime`: `MessageRegistry`, which generated code imports at runtime.
- `generate-contracts`: the standalone CLI.

The generated package needs its own dependencies; see [What the generated package needs](#what-the-generated-package-needs).

## Quick start

1. Mark a command in your backend. A command is a message that asks the backend to do something.

    ```typescript
    // packages/orders/src/messages/place-order.ts
    import { Command } from "@hexaijs/contracts";
    import { ContractCommand } from "@hexaijs/contracts/decorators";

    import type { Money } from "../domain/money.js";

    @ContractCommand({ response: "PlaceOrderResult" })
    export class PlaceOrderCommand extends Command<
        { customerId: string; total: Money },
        PlaceOrderResult
    > {
        static readonly type = "orders.place-order";
    }

    type PlaceOrderResult = {
        orderId: string;
    };

    export class PlaceOrderHandler {
        async execute(command: PlaceOrderCommand): Promise<PlaceOrderResult> {
            return { orderId: "order-1" };
        }
    }
    ```

    ```typescript
    // packages/orders/src/domain/money.ts
    export type Currency = "KRW" | "USD";

    export interface Money {
        amount: number;
        currency: Currency;
    }

    export function formatMoney(money: Money): string {
        return `${money.amount} ${money.currency}`;
    }
    ```

2. Create `application.config.ts` at the monorepo root.

    ```typescript
    export default {
        contracts: {
            contexts: ["packages/orders"],
        },
    };
    ```

3. Run the generator from the same directory.

    ```bash
    npx generate-contracts -o packages/contracts/src --registry
    ```

4. Look at the result.

    ```text
    packages/contracts/src/
    ├── index.ts                     # namespace export and messageRegistry (written because of --registry)
    └── orders/
        ├── index.ts                 # export * from every copied file
        ├── domain/money.ts          # Currency and Money only; formatMoney is not used, so it is left out
        └── messages/place-order.ts
    ```

    ```typescript
    // packages/contracts/src/orders/messages/place-order.ts
    import { Command } from "@hexaijs/contracts";
    import type { Money } from "../domain/money.js";
    export type PlaceOrderResult = {
        orderId: string;
    };
    export class PlaceOrderCommand extends Command<{
        customerId: string;
        total: Money;
    }, PlaceOrderResult> {
        static readonly type = "orders.place-order";
    }
    ```

    The decorator and its import are gone, `PlaceOrderHandler` stayed in the backend, and `PlaceOrderResult` gained `export`.

5. Give `packages/contracts` a `package.json` and the dependencies listed in [What the generated package needs](#what-the-generated-package-needs); the generator writes only `.ts` files. Then import it from the frontend (here it is named `@acme/contracts`).

    ```typescript
    import type { MessageHeaders } from "@hexaijs/plugin-contracts-generator/runtime";
    import { messageRegistry, orders } from "@acme/contracts";

    const command = new orders.PlaceOrderCommand({
        customerId: "customer-1",
        total: { amount: 12000, currency: "KRW" },
    });

    // Turn a message that arrives as headers and body back into a class instance.
    function receive(headers: MessageHeaders, body: Record<string, unknown>) {
        return messageRegistry.dehydrate(headers, body);
    }
    ```

## Concepts

- **Contract**: a declaration that the generator copies into the generated package. There are two kinds:
  - **Message contract**: a command, query or event class marked with a decorator. Message contracts can be registered in `MessageRegistry`.
  - **General contract**: any other marked class, interface, type alias or enum, such as a read model or a value object. General contracts are copied and exported, but never registered.
- **Marker**: how you mark a contract. Classes take a decorator; any declaration can take a comment marker. Markers do nothing at runtime.
- **Kind**: the role of a contract. `command`, `query` and `event` are message kinds. Every other value (`contract` by default, or your own, such as `read-model`) makes a general contract.
- **Visibility**: `public` (default) or `internal`. Outputs use it to keep internal contracts out of the public package.
- **Tags**: free labels for extra output filters. Tags are not a security boundary; use visibility for that.
- **Context**: one bounded context, usually one backend package. Each context gets its own folder in the output, named after the context.
- **Entry file**: a source file that contains at least one marker. The generator copies only the marked declarations from it, plus the local declarations they use.
- **Dependency file**: a local file that an entry file imports. The generator copies the parts that are used (see [Dependency strategies](#dependency-strategies)).
- **Output**: a directory that receives generated files. A run writes one output (`-o`) or several (`outputs[]`).

A run works in this order for every context and output:

1. **Scan** `<context>/<sourceDir>/**/*.ts` for files that contain markers.
2. **Parse** those files and collect the marked contracts.
3. **Select** the contracts that the output asks for.
4. **Copy** the selected declarations, the local types they use and their dependency files into `<output>/<context>/`, keeping the source folder layout.
5. **Write** `<output>/<context>/index.ts`, and `<output>/index.ts` when the registry is on.

## Marking contracts

### Message decorators

Import the decorators from `@hexaijs/contracts/decorators` (or `@hexaijs/contracts`).

| Decorator | Marks | Options |
|-----------|-------|---------|
| `@ContractCommand(options?)` | a command | `response`, `visibility`, `tags`, `context` |
| `@ContractQuery(options?)` | a query | `response`, `visibility`, `tags`, `context` |
| `@ContractEvent(options?)` | an event | `version`, `visibility`, `tags`, `context` |
| `@Contract(options?)` | a message when `kind` is `"command"`, `"query"` or `"event"`; a general contract otherwise | `kind`, `response`, `version`, `visibility`, `tags`, `context` |

| Option | Effect |
|--------|--------|
| `visibility` | `"public"` (default) or `"internal"`. Matched by `outputs[].select.visibility`. |
| `tags` | String array. Matched by `outputs[].select.tags`. |
| `kind` | `Contract` only. The contract role; defaults to `"contract"`. |
| `response` | Commands and queries. Names the response type, which must live in the same file. See [Response types](#response-types). |
| `version` | Events. Recorded as `version` on the parse result only. It changes neither the generated files nor the registry, which keys messages by the class's static `type` and `schemaVersion`. |
| `context` | Recorded as `context` on the parse result only. The output folder name comes from the context configuration. |

The generator reads options from the source text, so only literal values count: strings, numbers, booleans and arrays of them. A constant such as `tags: BUS_TAGS` is ignored.

```typescript
import { DomainEvent } from "@hexaijs/core";
import { Command, Query } from "@hexaijs/contracts";
import { Contract, ContractEvent, ContractQuery } from "@hexaijs/contracts/decorators";

@ContractEvent()
export class OrderPlaced extends DomainEvent<{
    orderId: string;
    customerId: string;
}> {
    static readonly type = "orders.order-placed";
}

@ContractQuery({ response: "OrderDetails" })
export class GetOrderQuery extends Query<{ orderId: string }, OrderDetails> {
    static readonly type = "orders.get-order";
}

type OrderDetails = {
    orderId: string;
    status: "placed" | "shipped";
};

@Contract({ kind: "command", visibility: "internal", tags: ["bus"] })
export class RebuildOrderIndexCommand extends Command<{ since: string }> {
    static readonly type = "orders.rebuild-order-index";
}
```

A message needs a decorator. A comment marker with a message kind, such as `// @Contract({ kind: "command" })`, is ignored.

### General contracts

Mark a class with `@Contract(...)`. Interfaces, type aliases and enums cannot carry decorators, so they use a comment marker instead. Classes accept comment markers too.

```typescript
import { Contract } from "@hexaijs/contracts/decorators";

@Contract({ kind: "snapshot" })
export class OrderSnapshot {
    constructor(public readonly orderId: string) {}
}

// @Contract({ kind: "read-model", tags: ["frontend"] })
interface OrderSummary {
    orderId: string;
    status: OrderStatus;
    channel: OrderChannel;
}

/* @Contract({ kind: "value-object" }) */
enum OrderChannel {
    Online = "online",
    Store = "store",
}

/**
 * Lifecycle of an order.
 * @Contract({ kind: "value-object", visibility: "internal", tags: ["admin"] })
 */
type OrderStatus = "draft" | "placed" | "cancelled";
```

Comment marker rules:

- The marker must be in a comment directly attached to the declaration: a line comment, a block comment or a JSDoc comment.
- One line of that comment must hold exactly `@Contract(...)`, options included. Other JSDoc lines may surround it; options cannot span lines.
- The parentheses are required. `// @Contract` without `()` is not a marker.
- A comment marker needs no import.
- If the marked declaration is not exported, the generator adds `export` in the output.

### Where decorators may come from

The generator recognizes `ContractEvent`, `ContractCommand`, `ContractQuery` and `Contract` only when the file imports them as named value imports from a trusted source:

- `@hexaijs/contracts`
- `@hexaijs/contracts/decorators`
- any entry in `contracts.trustedDecoratorSources`

Named aliases work:

```typescript
import { ContractCommand as InternalCommand } from "@hexaijs/contracts/decorators";

@InternalCommand({ visibility: "internal", tags: ["bus"] })
export class RebuildSearchIndexCommand {}
```

These forms are not recognized:

- A same-named decorator from another package, or a name with no import at all.
- A type-only import.
- A namespace import, such as `@Contracts.ContractCommand()` after `import * as Contracts from "@hexaijs/contracts/decorators"`. (Namespace imports of ordinary types still work in copied files.)
- A re-export through your own barrel file, unless you add that module to `trustedDecoratorSources`. The generator does not follow re-export chains.
- An import from `@hexaijs/plugin-contracts-generator`. The package re-exports the decorators, but the scanner and parser do not trust it as a source. Import from `@hexaijs/contracts/decorators` instead.

The deprecated `Public*` names are matched by name alone, wherever they are imported from (see [Migrating from `Public*` markers](#migrating-from-public-markers)).

### Response types

A command or query can have a response type. The generator finds it in one of two ways:

1. The `response` option names it: `@ContractCommand({ response: "PlaceOrderResult" })`.
2. A configured naming convention matches it. With `responseNamingConventions: [{ messageSuffix: "Query", responseSuffix: "QueryResult" }]`, `GetOrderQuery` matches `GetOrderQueryResult`.

The `response` option wins when both apply. The response type must be a `type` alias or an `interface` in the same file as the message. The generator copies it and adds `export` when the source does not export it.

The generator also keeps same-file declarations whose names follow fixed patterns, even when nothing references them: `<Message>Response` and `<Message>Payload`, `<Base>Response` and `<Base>Payload` for a `<Base>Request`, and `<Base>QueryResult` and `<Base>Payload` for a `<Base>Query`.

## Configuration

The standalone CLI reads `application.config.ts` from the current directory by default (`-c` picks another file). The file must default-export an object with a `contracts` section.

```typescript
// application.config.ts
export default {
    contracts: {
        contexts: [
            "packages/orders",
            {
                name: "inventory",
                path: "packages/inventory",
                sourceDir: "lib",
                tsconfigPath: "tsconfig.build.json",
            },
        ],
        responseNamingConventions: [
            { messageSuffix: "Command", responseSuffix: "CommandResult" },
            { messageSuffix: "Query", responseSuffix: "QueryResult" },
        ],
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
                select: { visibility: ["internal"], messageKinds: ["command"] },
            },
        ],
    },
};
```

The loader compiles the file and evaluates it without a module loader. Keep it self-contained: a runtime `import` fails with `require is not defined`. Type-only imports are fine.

### Options

| Field | Default | Description |
|-------|---------|-------------|
| `contexts` | required | Contexts to scan. See [Contexts](#contexts). |
| `outputs` | none | Output directories with their own selection. Without it, pass `-o`. See [Multiple outputs](#multiple-outputs). |
| `responseNamingConventions` | none | `{ messageSuffix, responseSuffix }` pairs for finding response types. |
| `dependencyStrategy` | `"safe-symbols"` | `"safe-symbols"` copies only the used declarations of dependency files and fails on files it cannot slice safely. `"file"` copies dependency files whole. See [Dependency strategies](#dependency-strategies). |
| `outputModuleSpecifiers` | `"js"` | `"js"` writes relative imports and exports with `.js` extensions, which `moduleResolution: "NodeNext"` and ESM need. `"extensionless"` writes them without extensions, for older generated packages. |
| `removeDecorators` | `true` | Removes contract decorators, comment markers and decorator imports from the output. |
| `pathAliasRewrites` | none | Prefix replacements for imports that stay outside the generated package. See [Path alias rewrites](#path-alias-rewrites). |
| `trustedDecoratorSources` | none | Extra modules from which `Contract*` decorator imports are trusted, such as your own decorator barrel. |
| `decoratorNames` | `{ event: "PublicEvent", command: "PublicCommand", query: "PublicQuery" }` | Legacy. Replaces the `Public*` message decorator names that are matched by name alone. |
| `contractMarkerNames` | `{ contract: "PublicContract" }` | Legacy. Replaces the `PublicContract` name for general contract decorators and comment markers. |
| `externalDependencies` | none | Accepted for compatibility. The generator does not use it. |

`entryStrategy` was removed in 0.7.0; a config that still sets it fails to load.

### Contexts

Each `contexts` entry is a string, a glob or an object. Paths are relative to the config file.

| Entry | Example | Result |
|-------|---------|--------|
| Path | `"packages/orders"` | One context named after the last path segment (`orders`). |
| Glob | `"packages/*"` | One context per directory under `packages/`, each named after its directory. Only one `*` is allowed. Text after the `*` filters directories: `"packages/*/src"` keeps directories that contain `src`. |
| Object | `{ name: "orders", path: "packages/orders" }` | One context with explicit settings. |

Object fields:

| Field | Default | Description |
|-------|---------|-------------|
| `name` | required | Context name and output folder name. |
| `path` | required | Context base directory. |
| `sourceDir` | `"src"` | Directory to scan, relative to `path`. |
| `tsconfigPath` | `"tsconfig.json"` | Relative to `path`. Its `paths` aliases resolve imports. A missing file is skipped. |
| `responseNamingConventions` | none | Used only when the top-level `responseNamingConventions` is not set. |

The scanner reads `.ts` files only and skips `node_modules`, `dist`, `*.d.ts`, `*.test.ts` and `*.spec.ts`. When the generator follows imports, it also leaves out files matching `*.test.ts`, `*.spec.ts`, `*.eh.ts`, `db.ts` and anything under an `infra/` directory, and removes the imports of those files from copied code.

A glob must not match the generated package. If `packages/*` also matches `packages/contracts`, the run treats it as a context and writes an empty `contracts/index.ts` into the output.

### Multiple outputs

`outputs[]` writes several packages in one run, for example a public package for the frontend and an internal package for backend tools. Each entry has:

| Field | Description |
|-------|-------------|
| `name` | Required and unique. Shown in logs. |
| `path` | Required. Output directory, relative to the config file. |
| `select` | Which contracts this output receives. Without it, the output receives every contract. |
| `registry` | `true` writes `<path>/index.ts` with a `MessageRegistry` for this output. |
| `outputModuleSpecifiers` | Overrides `outputModuleSpecifiers` for this output. |

`select` fields:

| Field | Keeps a contract when |
|-------|-----------------------|
| `visibility` | its visibility is in the list (`"public"`, `"internal"`). |
| `kinds` | its kind is in the list. Messages have the kinds `command`, `query` and `event`. |
| `messageKinds` | it is a message of a listed kind (`command`, `query`, `event`). Setting this drops all general contracts. |
| `include` | it is in the category: `"all"`, `"messages"` or `"contracts"`. |
| `tags.include` | it has at least one listed tag. |
| `tags.exclude` | it has none of the listed tags. |

A contract must pass every field that is set.

When `outputs[]` is set, run without `-o`; the CLI rejects the combination. `--include` and `--messages` still apply to every output on top of its `select`, and `--registry` turns the registry on for every output.

**Boundary check.** When an output sets any `select` field, the generator checks every file before writing it. If a file would carry a marked declaration that the output does not select, the run fails with `BoundaryViolationError`. This happens, for example, when a public message uses a type from a dependency file that also holds an `internal` contract, and that file is copied whole. Fix it by moving shared types behind public markers, adjusting the selection, or splitting the file.

**Single-output mode does not filter by visibility.** Without `outputs[]`, `-o` receives every contract, `internal` ones included. Use `outputs[]` with `select.visibility` before you publish a package that must not contain internal contracts.

### Path alias rewrites

`pathAliasRewrites` maps import prefixes to replacements in every copied file. Use it for imports that stay external to the generated package, such as a shared package that the frontend reaches under another name. Imports that resolve to files inside the context are rewritten to relative paths without it.

```typescript
export default {
    contracts: {
        contexts: ["packages/orders"],
        pathAliasRewrites: {
            "@acme/shared": "@acme/contracts/shared",
        },
    },
};
```

With this config, `import { Money } from "@acme/shared/money"` becomes `import { Money } from "@acme/contracts/shared/money"`. The CLI and the hexai plugin then write a re-export file for each rewritten import, under the output directory at the path after the package name: `shared/money.ts` with `export { Money } from "@acme/shared/money";`. The generated package therefore needs the original package as a dependency. `processContext()` rewrites imports but does not write re-export files.

## Running the generator

### Standalone CLI

```bash
npx generate-contracts -o packages/contracts/src [options]
npx generate-contracts -c application.config.ts [options]    # when contracts.outputs is set
```

| Option | Description |
|--------|-------------|
| `-o, --output-dir <path>` | Output directory, relative to the config file. Required unless `contracts.outputs` is set; rejected when it is. |
| `-c, --config <path>` | Config file (default: `application.config.ts`). |
| `--include <mode>` | `all` (default), `messages` (message contracts only) or `contracts` (general contracts only). |
| `--messages <types>` | Comma-separated message kinds to keep: `event`, `command`, `query`. Does not affect general contracts. |
| `-m, --message-types <types>` | Alias for `--messages`. |
| `--dependency-strategy <strategy>` | `safe-symbols` or `file`. Overrides the config. |
| `--output-module-specifiers <style>` | `js` or `extensionless`. Overrides the config, but not an output's own setting. |
| `--registry` | Writes `<output>/index.ts` with namespace exports and a `MessageRegistry`. |
| `--generate-message-registry` | Alias for `--registry`. |
| `--dry-run` | Generates into a temporary directory, prints counts and the file list, and leaves the output untouched. |
| `--check` | Generates into a temporary directory and compares it with the output directory. Fails on missing, extra or changed files. |
| `-h, --help` | Prints help. |

Unrecognized arguments are ignored. On any error the CLI prints `Error: <message>` and exits with code 1.

Common workflows:

```bash
# Preview, then generate with a registry
npx generate-contracts -o packages/contracts/src --dry-run
npx generate-contracts -o packages/contracts/src --registry

# Commands and events only
npx generate-contracts -o packages/contracts/src --include messages --messages event,command

# General contracts only
npx generate-contracts -o packages/contracts/src --include contracts

# Fail CI when the committed output is stale
npx generate-contracts -o packages/contracts/src --registry --check

# Generate every configured output
npx generate-contracts -c application.config.ts
```

The generator never deletes files. After you remove or rename a contract, clear the output directory before you regenerate; `--check` reports leftover files as extra files. For the same reason, point each output at a directory that holds only generated files.

### Run as a hexai CLI plugin

With [`@hexaijs/cli`](../cli/README.md) installed, register the plugin in `hexai.config.ts`. The plugin `config` is the same object as the `contracts` section of `application.config.ts`.

```typescript
// hexai.config.ts
export default {
    plugins: [
        {
            plugin: "@hexaijs/plugin-contracts-generator",
            config: {
                contexts: ["packages/orders", "packages/inventory"],
                outputs: [
                    {
                        name: "public",
                        path: "packages/contracts/src",
                        registry: true,
                        select: { visibility: ["public"] },
                    },
                ],
            },
        },
    ],
};
```

```bash
pnpm hexai generate-contracts
pnpm hexai generate-contracts --check
```

The command takes the same options as the standalone CLI, except `-c`, because the config comes from `hexai.config.ts`. Without `outputs`, pass `-o` as usual. Relative paths, in the plugin config and in `-o`, resolve against the current working directory, not the config file.

### Programmatic API

`processContext()` runs the pipeline for one context. It neither writes a root `index.ts` nor re-export files; the CLI adds those.

```typescript
import { ConsoleLogger, processContext } from "@hexaijs/plugin-contracts-generator";

const result = await processContext({
    contextName: "orders",
    path: "packages/orders",
    outputDir: "packages/contracts/src",
    removeDecorators: true,
    messageTypes: ["event", "command"],
    responseNamingConventions: [
        { messageSuffix: "Query", responseSuffix: "QueryResult" },
    ],
    logger: new ConsoleLogger({ level: "info" }),
});

console.log(
    `${result.events.length} events, ${result.commands.length} commands, ` +
        `${result.publicContracts.length} general contracts, ${result.copiedFiles.length} files`
);
```

| Option | Default | Description |
|--------|---------|-------------|
| `contextName` | required | Context name and output folder name. |
| `path` | required | Context base directory, relative to the current working directory. |
| `outputDir` | required | Output directory; files go to `<outputDir>/<contextName>/`. |
| `sourceDir` | `"src"` | Relative to `path`. |
| `tsconfigPath` | `"tsconfig.json"` | Relative to `path`. |
| `removeDecorators` | `false` | Unlike the CLI, decorators stay unless you set this to `true`. |
| `messageTypes` | all | Message kinds to keep. |
| `includePublicContracts` | `true` | Whether to keep general contracts. |
| `dependencyStrategy` | `"safe-symbols"` | See [Dependency strategies](#dependency-strategies). |
| `outputModuleSpecifiers` | `"js"` | Relative specifier style. |
| `pathAliasRewrites` | none | A `Map<string, string>` of prefix replacements. |
| `responseNamingConventions`, `decoratorNames`, `contractMarkerNames`, `trustedDecoratorSources` | none | As in the config file. |
| `fileSystem` | `nodeFileSystem` | `FileSystem` implementation, for tests. |
| `logger` | `noopLogger` | `Logger` implementation. |

For finer control, `ContractsPipeline.create(...)` exposes `execute()` and the individual steps `scan()`, `parse()`, `resolve()`, `copy()` and `exportBarrel()`. `RegistryGenerator` builds the root `index.ts` text from per-context results. The [architecture guide](./docs/ARCHITECTURE.md) describes each module.

## Generated output

### Layout

```text
<output>/
├── index.ts                  # only with --registry or registry: true
├── orders/
│   ├── index.ts              # export * from './<file>.js' for every copied file
│   ├── domain/money.ts       # copied files keep their path relative to sourceDir
│   └── messages/place-order.ts
└── inventory/
    └── ...
```

- Each copied file holds the selected declarations, the local declarations they use, and the imports those need. Classes stay classes, with their methods.
- Every declaration taken from an entry file is exported in the output, including local helpers that were not exported in the source.
- Every context gets `<context>/index.ts`, even when it has no contracts (then the file is empty).
- Most files pass through the TypeScript printer, so blank lines and line breaks can differ from the source. Expect formatting changes in diffs when you adopt the generator or change `removeDecorators`.
- The generator writes only `.ts` files. It does not write `package.json` or `tsconfig.json`.

### Root index and `MessageRegistry`

With the registry on, `<output>/index.ts` exports every context that has messages as a namespace and registers each selected message class:

```typescript
import { MessageRegistry } from "@hexaijs/plugin-contracts-generator/runtime";
import * as orders from "./orders/index.js";

export * as orders from "./orders/index.js";

export const messageRegistry = new MessageRegistry()
    .register(orders.PlaceOrderCommand);
```

- Namespaces keep same-named classes from different contexts apart. Kebab-case context names become camelCase (`video-lesson` becomes `videoLesson`).
- Contexts with only general contracts are not exported from the root index. Import them from `<context>/index.ts`, or write your own root index.
- General contracts are never registered.

`MessageRegistry` (from `@hexaijs/plugin-contracts-generator/runtime`) maps a message type to its class:

| Method | Description |
|--------|-------------|
| `register(messageClass)` | Registers a class under `getType()` and `getSchemaVersion()`; for a hexai `Message` these come from the static `type` (or the class name) and `schemaVersion`. Throws when the pair is already registered. Returns the registry. |
| `dehydrate<T>(headers, body)` | Finds the class for `headers.type` and `headers.schemaVersion` and calls its static `from(body, headers)`. Throws when the type is not registered. |
| `has(type, version?)` | Whether a type is registered. |
| `size()` | Number of registered classes. |

### What the generated package needs

The generated package is an ordinary TypeScript package that you own. Give it:

- a `package.json` whose dependencies cover what the copied files import, typically `@hexaijs/core` (for `DomainEvent`) and `@hexaijs/contracts` (for `Command` and `Query`);
- `@hexaijs/plugin-contracts-generator` as a dependency when the registry is on, because the root index imports `@hexaijs/plugin-contracts-generator/runtime`;
- the original packages behind any `pathAliasRewrites` re-exports;
- a `tsconfig.json` that accepts `.js` relative specifiers (for example `"moduleResolution": "NodeNext"`), unless you generate with `extensionless`;
- `experimentalDecorators` if you keep decorators (`removeDecorators: false`).

## Dependency strategies

When an entry file imports a local file, the generator must decide how much of that file to copy.

**`safe-symbols` (default)** copies only the top-level declarations that the selected contracts use, following named imports from file to file. It includes value declarations referenced through `typeof`. It refuses to slice a file whose top level might do something when loaded, and fails with `UnsafeDependencySliceError` (file path and reason) instead of copying the file whole. It rejects:

- side-effect imports (`import "./setup"`) and dynamic imports;
- `import("./x").T` type references to local files;
- `export ... from` re-exports, `export { ... }` lists and `export default` or `export =` assignments;
- class or member decorators, static blocks, computed member names, static member initializers (such as `static readonly type = "..."`) and `extends` clauses other than a plain class name;
- enum members with initializers;
- top-level variables initialized with calls, `new`, tagged templates, `await`, assignments and similar expressions, and any other top-level statement;
- duplicate top-level names, and default or namespace imports that a used declaration needs.

Dependency files outside the context's source directory are always copied whole, so two contexts that share a file never overwrite each other's slices. Boundary checks still apply to them.

**`file`** copies every used dependency file whole and follows its imports, including barrels (`export * from "./module"`). Use it when your dependency files rely on shapes that `safe-symbols` rejects.

Both strategies resolve relative imports written for NodeNext (`./shared.js`) back to the TypeScript source (`shared.ts`). Neither runs the TypeScript type checker; they work on the syntax tree. Keep shared types side-effect free and out of barrels to stay on the default path.

## Errors

Every error class of the generator extends `MessageParserError`, so one `instanceof` check catches them all.

```typescript
import {
    BoundaryViolationError,
    ConfigLoadError,
    FileReadError,
    MessageParserError,
    processContext,
    UnsafeDependencySliceError,
} from "@hexaijs/plugin-contracts-generator";

try {
    await processContext({
        contextName: "orders",
        path: "packages/orders",
        outputDir: "packages/contracts/src",
    });
} catch (error) {
    if (error instanceof UnsafeDependencySliceError) {
        console.error(`Cannot slice ${error.filePath}: ${error.reason}`);
    } else if (error instanceof BoundaryViolationError) {
        console.error(error.message);
    } else if (error instanceof FileReadError) {
        console.error(`Cannot read ${error.path}`, error.cause);
    } else if (error instanceof ConfigLoadError) {
        console.error(`Invalid config: ${error.message}`);
    } else if (error instanceof MessageParserError) {
        console.error(`Generator error: ${error.message}`);
    }
}
```

| Error | Thrown when |
|-------|-------------|
| `MessageParserError` | Base class of all errors below. |
| `ConfigurationError` | An option is invalid, for example a removed `entryStrategy` or an unknown `dependencyStrategy` passed to the API. |
| `ConfigLoadError` (extends `ConfigurationError`) | The config file or plugin config is missing a required field or holds an invalid value. |
| `BoundaryViolationError` | An output with a `select` would copy a marked declaration it does not select. |
| `UnsafeDependencySliceError` | `safe-symbols` cannot slice a dependency file. Has `filePath` and `reason`. |
| `FileReadError`, `FileWriteError` (extend `FileSystemError`) | A source file cannot be read or an output file cannot be written. Have `path` and `cause`. |
| `FileNotFoundError`, `ParseError`, `JsonParseError`, `ResolutionError`, `ModuleResolutionError` | Exported for callers, but the current pipeline does not throw them. |

Some failures are a plain `Error`: invalid CLI arguments (for example an unknown `--include` value), a failed `--check`, an unparsable `tsconfig.json`, and a `processContext()` call without `contextName` or `path`.

## API reference

Exports of `@hexaijs/plugin-contracts-generator`:

| Export | Description |
|--------|-------------|
| `processContext(options)` | Runs the pipeline for one context. Returns `ProcessContextResult` (`events`, `commands`, `queries`, `publicContracts`, `copiedFiles`). |
| `ContractsPipeline` | The pipeline with step-by-step methods. |
| `Scanner`, `Parser`, `FileGraphResolver`, `FileCopier` | The pipeline stages. |
| `ConfigLoader`, `resolveContextEntries`, `ContextConfig` | Config loading and context resolution. |
| `RegistryGenerator`, `ReexportGenerator` | Root index and re-export file generation. |
| `cliPlugin` | The plugin definition loaded by `@hexaijs/cli`. |
| `ConsoleLogger`, `noopLogger`, `nodeFileSystem` | Default logger and file system implementations. |
| `ContractEvent`, `ContractCommand`, `ContractQuery`, `Contract` and their option types | Re-exported from `@hexaijs/contracts/decorators`. Import them from there in your source; see [Where decorators may come from](#where-decorators-may-come-from). |
| `PublicEvent`, `PublicCommand`, `PublicQuery`, `PublicContract` | Deprecated aliases, re-exported from `@hexaijs/contracts/decorators`. |
| Error classes | See [Errors](#errors). |
| Domain types and type guards | `ContractDeclaration`, `DomainEvent`, `Command`, `Query`, `PublicContract` (type), `TypeRef`, `isDomainEvent()` and others. See the [domain model guide](./docs/DOMAIN-MODEL.md). |
| Config types | `ContractOutputConfig`, `ContractOutputSelect`, `DependencyStrategy`, `OutputModuleSpecifiers`, `DecoratorNames`, `ContractMarkerNames`, `TrustedDecoratorSources`, `ContractsConfig`. |

Exports of `@hexaijs/plugin-contracts-generator/runtime`: `MessageRegistry` and the types `MessageClass` and `MessageHeaders`.

## Migrating from `Public*` markers

`PublicEvent`, `PublicCommand`, `PublicQuery` and `PublicContract` are deprecated aliases since `@hexaijs/contracts` 0.3.0. They still work, print no warnings and produce the same metadata as `ContractEvent`, `ContractCommand`, `ContractQuery` and `Contract`, including the `"public"` default visibility. Unlike the current names, they are matched by name alone, whatever they are imported from, and `decoratorNames` and `contractMarkerNames` can rename them.

1. Replace `PublicEvent`, `PublicCommand` and `PublicQuery` with `ContractEvent`, `ContractCommand` and `ContractQuery`, imported from `@hexaijs/contracts/decorators`.
2. Replace `@PublicContract()` on classes with `@Contract()` or a specific kind, such as `@Contract({ kind: "read-model" })`.
3. Replace `// @PublicContract()` comment markers with `// @Contract()` or a specific kind.
4. Add `visibility: "internal"` to contracts that must stay out of public packages.
5. Add `outputs[]` with `select.visibility` before you generate internal contracts from the same source tree.

Other breaking changes:

- 0.7.0 removed `entryStrategy` (config, CLI flag and API option). Entry files always use symbol extraction. The default `dependencyStrategy` became `"safe-symbols"`; set `"file"` to keep the old whole-file copying.
- 0.5.1 made `.js` relative specifiers the default. Set `outputModuleSpecifiers: "extensionless"` to keep extensionless output.

## Known limitations

- `safe-symbols` accepts only statically safe dependency files; see [Dependency strategies](#dependency-strategies).
- Generation is not atomic. A failure such as `BoundaryViolationError` can leave a partly written output.
- Namespace decorator imports such as `@Contracts.ContractCommand()` are not recognized.
- Re-export chains are not followed when matching decorators; add local barrels to `trustedDecoratorSources`.
- Marker options must be literals.

## See also

- [`@hexaijs/contracts`](../contracts/README.md): the marker decorators and the `Command` and `Query` base classes.
- [`@hexaijs/core`](../core/README.md): `DomainEvent` and `Message`.
- [`@hexaijs/cli`](../cli/README.md): the `hexai` command that runs this plugin.
- [`@hexaijs/plugin-application-builder`](../plugin-application-builder/README.md): the companion plugin that generates `ApplicationBuilder` code from decorated handlers.
- [Architecture guide](./docs/ARCHITECTURE.md) and [domain model guide](./docs/DOMAIN-MODEL.md): for contributors.
