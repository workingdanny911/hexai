# @hexaijs/contracts

> Zero-dependency marker decorators and base message classes for hexai contract definitions

## Overview

`@hexaijs/contracts` provides the foundational contract types used across hexai:

- **Command** and **Query** base classes with typed payload and result
- **Decorator markers** (`@PublicEvent`, `@PublicCommand`, `@PublicQuery`) for static analysis by the contracts generator

This package has no runtime dependencies beyond `@hexaijs/core` as a peer dependency.

## Installation

```bash
npm install @hexaijs/contracts
```

## Core Exports

### Command and Query

Base classes for CQRS messages. Both accept two type parameters:

```typescript
import { Command, Query } from "@hexaijs/contracts";

class CreateOrderCommand extends Command<
    { customerId: string; items: Item[] },  // Payload
    { orderId: string }                     // ResultType
> {
    static readonly type = "order.create-order";
}

class GetOrderQuery extends Query<
    { orderId: string },  // Payload
    OrderDto              // ResultType
> {
    static readonly type = "order.get-order";
}
```

`Command` and `Query` extend `Message<Payload>` from `@hexaijs/core`, adding a phantom `ResultType` property for TypeScript type inference.

### Decorators (`@hexaijs/contracts/decorators`)

Pure no-op markers used by `@hexaijs/plugin-contracts-generator` for static analysis. They have no runtime effect.

```typescript
import { PublicCommand, PublicEvent, PublicQuery } from "@hexaijs/contracts/decorators";

@PublicCommand()
class CreateOrderCommand extends Command<CreateOrderPayload, CreateOrderResult> { ... }

@PublicEvent({ version: 2 })
class OrderPlaced extends DomainEvent<OrderPlacedPayload> { ... }

@PublicQuery({ response: "UserProfile" })
class GetUserQuery extends Query<{ userId: string }, UserProfile> { ... }
```

#### Decorator Options

| Decorator | Options |
|-----------|---------|
| `@PublicEvent(options?)` | `version?: number` — event version; `context?: string` — business context (inferred from package) |
| `@PublicCommand(options?)` | `context?: string` — business context; `response?: string` — explicit response type name |
| `@PublicQuery(options?)` | `context?: string` — business context; `response?: string` — explicit response type name |

## API Highlights

| Export | Subpath | Description |
|--------|---------|-------------|
| `Command<P, O>` | `.` | Base class for commands with payload and output type |
| `Query<P, O>` | `.` | Base class for queries with payload and output type |
| `PublicEvent` | `./decorators` | No-op marker for domain events |
| `PublicCommand` | `./decorators` | No-op marker for commands |
| `PublicQuery` | `./decorators` | No-op marker for queries |

## See Also

- [@hexaijs/application](../application/README.md) — Application layer that consumes these contracts
- [@hexaijs/plugin-contracts-generator](../plugin-contracts-generator/README.md) — Generates frontend-compatible types from decorated classes
