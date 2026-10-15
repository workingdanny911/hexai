# @hexaijs/contracts

> Base `Command` and `Query` classes and marker decorators for hexai contract definitions

`@hexaijs/contracts` gives you two things. `Command` and `Query` are base classes for the messages an application executes, typed with both their payload and their result. The contract decorators (`@ContractCommand()`, `@ContractQuery()`, `@ContractEvent()` and `@Contract()`) mark the declarations that other parts of your system depend on. A contract is any declaration you share outside its bounded context, for example with a frontend. The decorators do nothing at runtime; [`@hexaijs/plugin-contracts-generator`](../plugin-contracts-generator/README.md) reads them at build time and copies the marked declarations into a standalone contracts package.

Use this package when you define commands and queries for [`@hexaijs/application`](../application/README.md), or when you mark declarations for the contracts generator.

## Installation

```bash
npm install @hexaijs/contracts @hexaijs/core
```

| Peer dependency | Used for |
|-----------------|----------|
| `@hexaijs/core` | `Command` and `Query` extend its `Message` class |

The supported versions are the `peerDependencies` ranges in `package.json`. The package has no other runtime dependencies. The `@hexaijs/contracts/decorators` entry point imports nothing, not even `@hexaijs/core`.

## Quick Start

Define a command, give it a result type and mark it as a contract:

```typescript
import { Command } from "@hexaijs/contracts";
import { ContractCommand } from "@hexaijs/contracts/decorators";

export type CreateOrderResult = { orderId: string };

@ContractCommand({ response: "CreateOrderResult" })
export class CreateOrderCommand extends Command<
    { customerId: string; productIds: string[] },
    CreateOrderResult
> {
    static readonly type = "order.create-order";
}

const command = new CreateOrderCommand({
    customerId: "customer-1",
    productIds: ["product-1"],
});
```

When an application from `@hexaijs/application` executes this command, `executeCommand(command)` returns `Promise<Result<CreateOrderResult>>`. The type comes from the second type parameter. `@ContractCommand()` changes nothing at runtime; it tells the contracts generator to include `CreateOrderCommand` and its response type `CreateOrderResult`.

## Commands and Queries

`Command<Payload, ResultType>` and `Query<Payload, ResultType>` extend `Message<Payload>` from `@hexaijs/core`.

- `Payload` is the data the message carries. `getPayload()` returns it.
- `ResultType` is the type a handler returns. It exists only at the type level: the class declares a `ResultType` property but never sets it. `@hexaijs/application` reads it to type `executeCommand()`, `executeQuery()` and handler return values.
- `static type` sets the message type, which is stored in the `type` header. Without it, the class name is used.
- Both constructors take `(payload, options?)`. `options` is `MessageOptions` from `@hexaijs/core`; use `options.headers` to add custom headers.
- `Command` sets the `intent` header to `"command"`, and `Query` sets it to `"query"`.

```typescript
import { Query } from "@hexaijs/contracts";

export type OrderSummary = { orderId: string; status: string };

export class GetOrderQuery extends Query<{ orderId: string }, OrderSummary> {
    static readonly type = "order.get-order";
}

const query = new GetOrderQuery(
    { orderId: "order-1" },
    { headers: { tenantId: "tenant-1" } }
);
```

`@hexaijs/application` re-exports `Command` and `Query`, so importing them from either package gives you the same class.

## Contract Decorators

Import the decorators from `@hexaijs/contracts/decorators` or from the package root. By default, the contracts generator recognizes them only when they are imported by name from one of these two paths. They work with both standard TypeScript decorators and `experimentalDecorators`.

| Decorator | Marks | Options type |
|-----------|-------|--------------|
| `@ContractCommand(options?)` | A command class | `ContractCommandOptions` |
| `@ContractQuery(options?)` | A query class | `ContractQueryOptions` |
| `@ContractEvent(options?)` | A domain event class | `ContractEventOptions` |
| `@Contract(options?)` | Any class, by `kind` | `ContractOptions` |

Every decorator accepts these options:

| Option | Type | Description |
|--------|------|-------------|
| `visibility` | `"public" \| "internal"` | Which side of the public/internal boundary the contract is on. Defaults to `"public"`. Generator outputs can select contracts by visibility. |
| `tags` | `readonly string[]` | Extra labels that generator outputs can filter by. Use `visibility`, not tags, to separate public and internal contracts. |
| `context` | `string` | Name of the business context the contract belongs to. |

Some decorators accept more:

| Option | Accepted by | Description |
|--------|-------------|-------------|
| `response` | `ContractCommand`, `ContractQuery`, `Contract` | Name of the response type, declared in the same file. Without it, the generator can match a response type by naming convention. |
| `version` | `ContractEvent`, `Contract` | Event version. |
| `kind` | `Contract` | What the contract is: `"command"`, `"query"`, `"event"`, `"contract"` (the default) or a custom string such as `"dto"` or `"read-model"`. |

```typescript
import { DomainEvent } from "@hexaijs/core";
import { Contract, ContractEvent } from "@hexaijs/contracts/decorators";

@ContractEvent({ version: 2, tags: ["frontend"] })
export class OrderPlaced extends DomainEvent<{ orderId: string }> {
    static readonly type = "order.order-placed";
}

@Contract({ kind: "read-model", visibility: "internal" })
export class OrderListItem {
    constructor(
        readonly orderId: string,
        readonly status: string
    ) {}
}
```

### Marking interfaces, type aliases and enums

TypeScript does not allow decorators on interfaces, type aliases or enums. Mark them with a leading comment that uses call syntax instead. Comment markers need no import. They work for general contracts only, not for commands, queries or events.

```typescript
// @Contract({ kind: "dto" })
export interface OrderLine {
    productId: string;
    quantity: number;
}

/** @Contract() */
export type OrderStatus = "draft" | "placed" | "cancelled";
```

The [contracts generator README](../plugin-contracts-generator/README.md) covers comment marker rules, output selection by `visibility` and `tags`, and response type matching.

## API Reference

| Export | Entry points | Description |
|--------|--------------|-------------|
| `Command<Payload, ResultType>` | `.` | Base class for commands |
| `Query<Payload, ResultType>` | `.` | Base class for queries |
| `ContractCommand` | `.`, `./decorators` | Marks a command contract |
| `ContractQuery` | `.`, `./decorators` | Marks a query contract |
| `ContractEvent` | `.`, `./decorators` | Marks an event contract |
| `Contract` | `.`, `./decorators` | Marks a contract of any `kind` |
| `ContractBaseOptions`, `ContractCommandOptions`, `ContractQueryOptions`, `ContractEventOptions`, `ContractOptions` | `.`, `./decorators` | Option types |
| `ContractVisibility`, `ContractKind`, `BuiltInContractKind`, `MessageContractKind` | `.`, `./decorators` | Types used by the options |
| `PublicCommand`, `PublicQuery`, `PublicEvent`, `PublicContract` and the `Public*Options` types | `.`, `./decorators` | Deprecated aliases; see the migration section |

## Migrating from `Public*` Decorators

Version 0.3.0 replaced the `Public*` decorators with the `Contract*` decorators. The old names remain as deprecated aliases of the new functions and types, so existing code keeps compiling.

| Deprecated | Replacement |
|------------|-------------|
| `@PublicCommand()` | `@ContractCommand()` |
| `@PublicQuery()` | `@ContractQuery()` |
| `@PublicEvent()` | `@ContractEvent()` |
| `@PublicContract()` | `@Contract()` |
| `PublicCommandOptions`, `PublicQueryOptions`, `PublicEventOptions`, `PublicContractOptions` | `ContractCommandOptions`, `ContractQueryOptions`, `ContractEventOptions`, `ContractOptions` |

Rename the imports and decorator calls; the options stay the same. The contracts generator still recognizes the `Public*` names, including `// @PublicContract()` comment markers.

## See Also

- [@hexaijs/application](../application/README.md): executes commands and queries and types their results
- [@hexaijs/plugin-contracts-generator](../plugin-contracts-generator/README.md): extracts marked contracts into a standalone package
- [@hexaijs/core](../core/README.md): `Message`, `DomainEvent` and `MessageOptions`
