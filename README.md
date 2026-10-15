# hexai

hexai is a set of TypeScript packages for building backend applications with hexagonal architecture, also called ports and adapters. Business logic sits at the center and reaches the outside world only through interfaces it defines, called ports. Databases and other infrastructure sit at the edges and implement those interfaces, as adapters.

hexai provides building blocks for each layer: domain types such as messages and domain events, an application layer that routes commands, queries and events to handlers, PostgreSQL and SQLite adapters with explicit transactions, and build tools that generate handler wiring and frontend contract types.

## Principles

- **The domain does not depend on infrastructure.** Business rules depend on ports you define, such as a repository interface, not on a database driver or a web framework.
- **Messages are the way in.** Code outside an application talks to it only through messages: commands change state, queries read state, and events report something that has happened.
- **Transactions are explicit.** A unit of work runs a block of code in a scope, and everything the block writes commits or rolls back together.
- **Tests swap adapters, not logic.** Handlers depend on ports, so a test can give them an in-memory repository and run the real handler.
- **No web framework is assumed.** hexai has no HTTP layer. Call an application from Express, Fastify, NestJS, a CLI or a queue consumer.

## Packages

All packages are published as ES modules only. Each package README covers installation, peer dependencies and the full API.

| Package | What it provides |
|---|---|
| [`@hexaijs/core`](./packages/core/README.md) | Domain building blocks (`Message`, `DomainEvent`, `AggregateRoot`, `Id`), port interfaces (`Repository`, `UnitOfWork`, `EventStore`, `EventPublisher`), and test helpers in `@hexaijs/core/test` |
| [`@hexaijs/contracts`](./packages/contracts/README.md) | The `Command` and `Query` base classes (also re-exported by `@hexaijs/application`), and the decorators `ContractCommand`, `ContractEvent`, `ContractQuery` and `Contract`, which mark declarations for the contracts generator |
| [`@hexaijs/application`](./packages/application/README.md) | The application layer: `ApplicationBuilder`, command, query and event handlers, `Result`, interceptors, `ExecutionScope` and `ApplicationEventPublisher`; a pino logger in `@hexaijs/application/pino` |
| [`@hexaijs/postgres`](./packages/postgres/README.md) | PostgreSQL unit of work, event store, transactional event store sink, migration runners and `PostgresConfig`; projections in `@hexaijs/postgres/projection`; test helpers in `@hexaijs/postgres/test` |
| [`@hexaijs/sqlite`](./packages/sqlite/README.md) | SQLite unit of work on `better-sqlite3`, for tests and lightweight deployments; test helpers in `@hexaijs/sqlite/test` |
| [`@hexaijs/cli`](./packages/cli/README.md) | The `hexai` command, which runs the plugins listed in a `hexai.config.ts`, `.js` or `.json` file |
| [`@hexaijs/plugin-application-builder`](./packages/plugin-application-builder/README.md) | Marker decorators for handlers, and a generator that writes the `ApplicationBuilder` registration code (`hexai generate-app-builder`) |
| [`@hexaijs/plugin-contracts-generator`](./packages/plugin-contracts-generator/README.md) | A generator that copies contract-marked messages, and the types they use, into a separate contracts package for frontends (`hexai generate-contracts`) |
| [`@hexaijs/utils`](./packages/utils/README.md) | `@hexaijs/utils/config`, a re-export of the `ezcfg` configuration library kept for backward compatibility |

## Example: placing an order

This example builds the write side of a small order service on PostgreSQL: a command, a handler that does its work in one transaction, a repository, and the wiring that connects them. File names are suggestions.

```bash
npm install @hexaijs/core @hexaijs/contracts @hexaijs/application @hexaijs/postgres pg ezcfg
```

The repository writes to this table:

```sql
CREATE TABLE orders (
    id text PRIMARY KEY,
    customer_id text NOT NULL,
    product_id text NOT NULL,
    quantity integer NOT NULL
);
```

### 1. Define the messages

A command asks an application to change state. `Command` takes two type parameters: the payload, and the result its handler returns. `executeCommand()` uses the second one to type its result. A domain event records something that has happened. The static `type` names each message; the application finds a message's handler by it.

```typescript
// src/orders/messages.ts
import { Command } from "@hexaijs/application";
import { DomainEvent } from "@hexaijs/core";

export class CreateOrderCommand extends Command<
    { customerId: string; productId: string; quantity: number },
    { orderId: string }
> {
    static readonly type = "order.create-order";
}

export class OrderPlaced extends DomainEvent<{
    orderId: string;
    customerId: string;
}> {
    static readonly type = "order.order-placed";
}
```

### 2. Define the ports

`OrderRepository` is a port: the handler needs it, and an adapter implements it. The application context is the object the application passes to every handler; it carries the ports and services the handlers use. Two of them are core interfaces: `UnitOfWork`, whose `scope()` runs a callback in one transaction, and `EventPublisher`, which publishes events.

```typescript
// src/orders/ports.ts
import type { EventPublisher, Message, UnitOfWork } from "@hexaijs/core";

export interface Order {
    id: string;
    customerId: string;
    productId: string;
    quantity: number;
}

export interface OrderRepository {
    add(order: Order): Promise<void>;
}

export interface OrderApplicationContext {
    unitOfWork: UnitOfWork;
    orders: OrderRepository;
    events: EventPublisher<Message>;
}
```

### 3. Write the handler

A command handler executes one command type. It receives the command and the application context, and returns the command's result. It does not know which database stores the order.

The application does not open a transaction by itself, so the handler opens a scope. What the callback writes commits when the callback returns, and rolls back when it throws. The application then turns the error into an `ErrorResult`.

```typescript
// src/orders/create-order-handler.ts
import { randomUUID } from "node:crypto";
import type { CommandHandler } from "@hexaijs/application";

import { CreateOrderCommand, OrderPlaced } from "./messages.js";
import type { OrderApplicationContext } from "./ports.js";

export class CreateOrderHandler
    implements CommandHandler<CreateOrderCommand, OrderApplicationContext>
{
    async execute(
        command: CreateOrderCommand,
        ctx: OrderApplicationContext
    ): Promise<{ orderId: string }> {
        const { customerId, productId, quantity } = command.getPayload();

        return ctx.unitOfWork.scope(async () => {
            const orderId = randomUUID();

            await ctx.orders.add({ id: orderId, customerId, productId, quantity });
            await ctx.events.publish(new OrderPlaced({ orderId, customerId }));

            return { orderId };
        });
    }
}
```

You can also open the scope in a command interceptor instead of in each handler. [Wiring the Unit of Work and Event Publishing](./packages/application/README.md#wiring-the-unit-of-work-and-event-publishing) describes that alternative and the `ErrorResult` pitfall it must handle.

### 4. Implement the repository for PostgreSQL

The Postgres unit of work runs queries through its `db` property, typed `PostgresQueryable`; give `db` to a repository once. Each query goes to the transaction of the scope that the calling code runs in, so the insert below joins the handler's scope. Outside any scope, a query runs on its own connection and commits by itself, like `pool.query()`, so a query handler that only reads does not need a scope.

```typescript
// src/orders/postgres-order-repository.ts
import type { PostgresQueryable } from "@hexaijs/postgres";

import type { Order, OrderRepository } from "./ports.js";

export class PostgresOrderRepository implements OrderRepository {
    constructor(private readonly db: PostgresQueryable) {}

    async add(order: Order): Promise<void> {
        await this.db.query(
            "INSERT INTO orders (id, customer_id, product_id, quantity) VALUES ($1, $2, $3, $4)",
            [order.id, order.customerId, order.productId, order.quantity]
        );
    }
}
```

### 5. Register the handlers

An application routes each message to its handler, and `ApplicationBuilder` assembles one. A function that registers the handlers lets production code and tests share the registration. [`@hexaijs/plugin-application-builder`](./packages/plugin-application-builder/README.md) can generate this function from decorated handlers.

```typescript
// src/orders/application.ts
import { ApplicationBuilder } from "@hexaijs/application";

import { CreateOrderHandler } from "./create-order-handler.js";
import { CreateOrderCommand } from "./messages.js";

export function createApplicationBuilder(): ApplicationBuilder {
    return new ApplicationBuilder().withCommandHandler(
        CreateOrderCommand,
        () => new CreateOrderHandler()
    );
}
```

### 6. Compose and run

The composition root is the one place that creates the adapters and wires them into the application. `executeCommand()` returns a `Result`: check `isError`, or call `getOrThrow()` to get the data or throw the error.

```typescript
// src/main.ts
import pg from "pg";
import { ApplicationEventPublisher } from "@hexaijs/application";
import { createPostgresUnitOfWork } from "@hexaijs/postgres";

import { createApplicationBuilder } from "./orders/application.js";
import { CreateOrderCommand } from "./orders/messages.js";
import { PostgresOrderRepository } from "./orders/postgres-order-repository.js";
import type { OrderApplicationContext } from "./orders/ports.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const unitOfWork = createPostgresUnitOfWork(pool);
const events = new ApplicationEventPublisher();

const context: OrderApplicationContext = {
    unitOfWork,
    orders: new PostgresOrderRepository(unitOfWork.db),
    events,
};

const application = createApplicationBuilder()
    .withApplicationContext(context)
    .build();

const result = await application.executeCommand(
    new CreateOrderCommand({
        customerId: "customer-1",
        productId: "product-1",
        quantity: 2,
    })
);

if (result.isError) {
    console.error("Order failed:", result.error.message);
} else {
    console.log("Order placed:", result.data.orderId);
}
```

`events` has no subscribers yet, so `OrderPlaced` goes nowhere. To store published events in the event store within the same transaction, attach `attachPostgresEventStoreSink(events, unitOfWork)`; see [`@hexaijs/postgres`](./packages/postgres/README.md). To deliver events to event handlers, see [Wiring the Unit of Work and Event Publishing](./packages/application/README.md#wiring-the-unit-of-work-and-event-publishing).

## Testing a command

The handler depends only on ports, so a test can build the same application with an in-memory repository, a unit of work whose `scope()` only runs the callback, and an event publisher whose events the test collects. `expectMessageToMatch()` from `@hexaijs/core/test` checks that a message of the given type, with the given payload fields, was published.

```typescript
// src/orders/create-order.test.ts
import { describe, expect, it } from "vitest";
import { ApplicationEventPublisher } from "@hexaijs/application";
import type { Message, UnitOfWork } from "@hexaijs/core";
import { expectMessageToMatch } from "@hexaijs/core/test";

import { createApplicationBuilder } from "./application.js";
import { CreateOrderCommand, OrderPlaced } from "./messages.js";
import type {
    Order,
    OrderApplicationContext,
    OrderRepository,
} from "./ports.js";

class InMemoryOrderRepository implements OrderRepository {
    readonly saved: Order[] = [];

    async add(order: Order): Promise<void> {
        this.saved.push(order);
    }
}

describe("CreateOrderCommand", () => {
    it("stores the order and publishes OrderPlaced", async () => {
        const unitOfWork: UnitOfWork = { scope: (fn) => fn() };
        const orders = new InMemoryOrderRepository();
        const events = new ApplicationEventPublisher();
        const published: Message[] = [];
        events.subscribe((event) => {
            published.push(event);
        });
        const context: OrderApplicationContext = { unitOfWork, orders, events };

        const application = createApplicationBuilder()
            .withApplicationContext(context)
            .build();

        const result = await application.executeCommand(
            new CreateOrderCommand({
                customerId: "customer-1",
                productId: "product-1",
                quantity: 2,
            })
        );

        const { orderId } = result.getOrThrow();
        expect(orders.saved).toEqual([
            {
                id: orderId,
                customerId: "customer-1",
                productId: "product-1",
                quantity: 2,
            },
        ]);
        expectMessageToMatch(published, OrderPlaced, {
            orderId,
            customerId: "customer-1",
        });
    });
});
```

To test SQL against a database, two packages help:

- `@hexaijs/postgres/test` provides `PostgresUnitOfWorkForTesting`, which runs inside a transaction that the test rolls back afterwards. Put it in the context as the unit of work, and give its `db` to `PostgresOrderRepository`. See [`@hexaijs/postgres`](./packages/postgres/README.md).
- `@hexaijs/sqlite` runs scopes on SQLite with `SqliteUnitOfWork`, and `getSqliteConnection()` from `@hexaijs/sqlite/test` opens an in-memory database by default. See [`@hexaijs/sqlite`](./packages/sqlite/README.md).

## Where to go next

| Topic | Read |
|---|---|
| Event handlers, `SelectorBasedEventHandler` and `@When` | [`@hexaijs/application`](./packages/application/README.md) |
| Interceptors, logging, and `ExecutionScope` (security context, correlation and causation) | [`@hexaijs/application`](./packages/application/README.md) |
| Messages, aggregates, repositories, units of work and the event store interface | [`@hexaijs/core`](./packages/core/README.md) |
| Transactions in depth: propagation, isolation levels, lifecycle hooks | [`@hexaijs/postgres`](./packages/postgres/README.md) |
| Event store, migrations and configuration with `PostgresConfig` | [`@hexaijs/postgres`](./packages/postgres/README.md) |
| Projections: read models built from the event store | [Projection infrastructure](./packages/postgres/docs/projection.md) |
| Generating handler registration from decorators | [`@hexaijs/plugin-application-builder`](./packages/plugin-application-builder/README.md) |
| Marking contracts and generating a contracts package for frontends | [`@hexaijs/contracts`](./packages/contracts/README.md), [`@hexaijs/plugin-contracts-generator`](./packages/plugin-contracts-generator/README.md) |
| Running plugins with the `hexai` command | [`@hexaijs/cli`](./packages/cli/README.md) |

## Contributing

[CONTRIBUTING.md](./CONTRIBUTING.md) explains how to install, build and test the repository, including the PostgreSQL setup that the `@hexaijs/postgres` tests need.

## Status

hexai is under active development. Every package is still at version 0.x, and a minor version can contain breaking changes. Read a package's `CHANGELOG.md` before you upgrade it.

## License

[MIT](./LICENSE)
