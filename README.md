# hexai

A TypeScript framework for building maintainable applications through hexagonal architecture.

## Philosophy

**hexai** believes that software complexity should be managed through clear boundaries, not clever abstractions.

### The Problem

Modern applications often become tangled messes where business logic is scattered across controllers, services, and infrastructure code. Testing becomes painful. Changes ripple unpredictably. The codebase fights back against every modification.

### Our Approach

hexai provides a structured way to keep your domain logic pure and your infrastructure concerns at the edges:

- **Domain at the center** — Your business rules live in isolation, unaware of databases, HTTP, or frameworks
- **Explicit boundaries** — Commands and Events define how the outside world interacts with your domain
- **Infrastructure as plugins** — Databases, message queues, and external services are swappable adapters

### Core Beliefs

1. **Testability is non-negotiable.** If it's hard to test, the design is wrong.

2. **The domain should be boring.** Pure functions, simple objects, no decorators or framework magic.

3. **Side effects belong at the boundaries.** Event publishing, persistence, and external calls happen in a controlled, predictable way.

4. **Transactions are explicit.** UnitOfWork makes it clear when and how state changes are committed.

5. **Framework-agnostic by design.** Express, Fastify, NestJS — hexai doesn't care. Your domain shouldn't either.

## Packages

### Foundation

| Package | Description |
|---------|-------------|
| [`@hexaijs/core`](./packages/core/README.md) | Domain primitives, messaging, and infrastructure interfaces |
| [`@hexaijs/application`](./packages/application/README.md) | Application layer with command handlers, contexts, and interceptors |
| [`@hexaijs/contracts`](./packages/contracts/README.md) | Zero-dependency marker decorators and base Command/Query classes |

### Infrastructure

| Package | Description |
|---------|-------------|
| [`@hexaijs/postgres`](./packages/postgres/README.md) | PostgreSQL adapter with UnitOfWork, event store, and migrations |
| [`@hexaijs/sqlite`](./packages/sqlite/README.md) | SQLite adapter for testing and lightweight deployments |

### Utilities

| Package | Description |
|---------|-------------|
| [`@hexaijs/utils`](./packages/utils/README.md) | Shared utility functions and configuration helpers |

### CLI & Build Tools

| Package | Description |
|---------|-------------|
| [`@hexaijs/cli`](./packages/cli/README.md) | Unified CLI tool for running hexai plugins |
| [`@hexaijs/plugin-application-builder`](./packages/plugin-application-builder/README.md) | Decorators for automatic handler registration |
| [`@hexaijs/plugin-contracts-generator`](./packages/plugin-contracts-generator/README.md) | Generate frontend-compatible contract types from domain events and commands |

## Recipes

Practical patterns for common use cases.

### Building a CQRS Application

Separate read and write operations with distinct handlers.

```typescript
// commands/create-order/command.ts
import { Command } from "@hexaijs/application";

export class CreateOrderCommand extends Command<{
    customerId: string;
    items: Array<{ productId: string; quantity: number }>;
}> {
    static readonly type = "order.create-order";
}

export type CreateOrderResult = {
    orderId: string;
};
```

```typescript
// commands/create-order/handler.ts
import { CommandHandler } from "@hexaijs/application";
import { CreateOrderCommand, CreateOrderResult } from "./command";
import { OrderApplicationContext } from "../../application-context";
import { OrderPlaced } from "./events";

export class CreateOrderHandler implements CommandHandler<
    CreateOrderCommand,
    OrderApplicationContext
> {
    async execute(
        command: CreateOrderCommand,
        ctx: OrderApplicationContext
    ): Promise<CreateOrderResult> {
        const payload = command.getPayload();
        const orderId = crypto.randomUUID();

        // Persist order
        const client = ctx.getUnitOfWork().getClient();
        await ctx.getOrderRepository().save(client, {
            id: orderId,
            customerId: payload.customerId,
            items: payload.items,
        });

        // Publish domain event
        await ctx.publish(new OrderPlaced({
            orderId,
            customerId: payload.customerId,
        }));

        return { orderId };
    }
}
```

```typescript
// queries/get-order/handler.ts
import { Query, QueryHandler } from "@hexaijs/application";
import { OrderApplicationContext } from "../../application-context";

export class GetOrderQuery extends Query<{ orderId: string }> {
    static readonly type = "order.get-order";
}

export class GetOrderHandler implements QueryHandler<
    GetOrderQuery,
    OrderApplicationContext
> {
    async execute(
        query: GetOrderQuery,
        ctx: OrderApplicationContext
    ): Promise<OrderDetails> {
        const client = ctx.getUnitOfWork().getClient();
        return ctx.getOrderRepository().findById(client, query.getPayload().orderId);
    }
}
```

**Key points:**
- `Command` for write operations, `Query` for read operations
- Handlers implement `CommandHandler` or `QueryHandler` interface
- The `execute()` method receives the message and context

**See also:** [@hexaijs/core](./packages/core/README.md), [@hexaijs/application](./packages/application/README.md)

---

### Testing with In-Memory Database

Use SQLite for fast, isolated tests.

```typescript
// test/fixtures.ts
import { Message } from "@hexaijs/core";
import { SqliteUnitOfWork } from "@hexaijs/sqlite";
import { OrderApplicationContext } from "../application-context";

export function createTestContext(): OrderApplicationContext & {
    uow: SqliteUnitOfWork;
    publishedMessages: Message[];
} {
    const uow = new SqliteUnitOfWork();
    const publishedMessages: Message[] = [];

    return {
        uow,
        publishedMessages,
        getUnitOfWork: () => uow,
        getOrderRepository: () => new InMemoryOrderRepository(),
        publish: async (message: Message) => {
            publishedMessages.push(message);
        },
    };
}
```

```typescript
// commands/create-order/handler.test.ts
import { setExpect, expectMessageToMatch } from "@hexaijs/core/test";
import { CreateOrderHandler } from "./handler";
import { CreateOrderCommand } from "./command";
import { OrderPlaced } from "./events";
import { createTestContext } from "../../test/fixtures";

setExpect(expect);

describe("CreateOrderHandler", () => {
    it("creates an order and publishes OrderPlaced", async () => {
        const ctx = createTestContext();
        const handler = new CreateOrderHandler();

        const result = await handler.execute(
            new CreateOrderCommand({
                customerId: "customer-123",
                items: [{ productId: "prod-1", quantity: 2 }],
            }),
            ctx
        );

        expect(result.orderId).toBeDefined();
        expectMessageToMatch(ctx.publishedMessages, OrderPlaced, {
            orderId: expect.any(String),
            customerId: "customer-123",
        });
    });
});
```

**Key points:**
- `SqliteUnitOfWork` provides an in-memory database
- Capture published messages in an array for assertions
- `expectMessageToMatch` from `@hexaijs/core/test` for event verification

**See also:** [@hexaijs/sqlite](./packages/sqlite/README.md), [@hexaijs/core](./packages/core/README.md)

---

### Domain Event Handling

React to events published by other handlers.

```typescript
// domain/events.ts
import { DomainEvent } from "@hexaijs/core";

export class OrderPlaced extends DomainEvent<{
    orderId: string;
    customerId: string;
}> {
    static readonly type = "order.order-placed";
}
```

```typescript
// event-handlers/send-order-confirmation.ts
import { Message } from "@hexaijs/core";
import { EventHandler } from "@hexaijs/application";
import { OrderPlaced } from "../domain/events";
import { NotificationApplicationContext } from "../application-context";

export class SendOrderConfirmation implements EventHandler<OrderPlaced, NotificationApplicationContext> {
    canHandle(message: Message): boolean {
        return message.getMessageType() === OrderPlaced.getType();
    }

    async handle(
        event: OrderPlaced,
        ctx: NotificationApplicationContext
    ): Promise<void> {
        const { orderId, customerId } = event.getPayload();

        await ctx.getEmailService().send({
            to: customerId,
            subject: "Order Confirmation",
            body: `Your order ${orderId} has been placed.`,
        });
    }
}
```

For handlers that respond to multiple event types, use `SelectorBasedEventHandler`:

```typescript
// event-handlers/order-notifications.ts
import { Message } from "@hexaijs/core";
import { SelectorBasedEventHandler, When, eventTypeMatches } from "@hexaijs/application";
import { OrderPlaced, OrderShipped } from "../domain/events";

export class OrderNotifications extends SelectorBasedEventHandler<Message, NotificationApplicationContext> {
    @When(eventTypeMatches(OrderPlaced.getType()))
    async onOrderPlaced(event: OrderPlaced, ctx: NotificationApplicationContext): Promise<void> {
        // Send order confirmation
    }

    @When(eventTypeMatches(OrderShipped.getType()))
    async onOrderShipped(event: OrderShipped, ctx: NotificationApplicationContext): Promise<void> {
        // Send shipping notification
    }
}
```

**Key points:**
- Events extend `DomainEvent<TPayload>` with a static `type`
- Simple handlers implement `EventHandler` interface with `canHandle()` and `handle()`
- Use `SelectorBasedEventHandler` with `@When` decorator for multi-event handlers

**See also:** [@hexaijs/core](./packages/core/README.md), [@hexaijs/application](./packages/application/README.md)

---

### Bootstrapping with Application Builder

Use the plugin to auto-register handlers from decorators.

```typescript
// commands/create-order/handler.ts
import { CommandHandler } from "@hexaijs/application";
import { CommandHandlerMarker } from "@hexaijs/plugin-application-builder";
import { CreateOrderCommand, CreateOrderResult } from "./command";
import { OrderApplicationContext } from "../../application-context";

@CommandHandlerMarker(CreateOrderCommand)
export class CreateOrderHandler implements CommandHandler<
    CreateOrderCommand,
    OrderApplicationContext
> {
    async execute(
        command: CreateOrderCommand,
        ctx: OrderApplicationContext
    ): Promise<CreateOrderResult> {
        // Implementation
    }
}
```

```typescript
// event-handlers/send-order-confirmation.ts
import { Message } from "@hexaijs/core";
import { EventHandler } from "@hexaijs/application";
import { EventHandlerMarker } from "@hexaijs/plugin-application-builder";
import { OrderPlaced } from "../domain/events";
import { OrderApplicationContext } from "../application-context";

@EventHandlerMarker()
export class SendOrderConfirmation implements EventHandler<OrderPlaced, OrderApplicationContext> {
    canHandle(message: Message): boolean {
        return message.getMessageType() === OrderPlaced.getType();
    }

    async handle(event: OrderPlaced, ctx: OrderApplicationContext): Promise<void> {
        // React to event
    }
}
```

```typescript
// application-builder.ts (auto-generated)
// Run: hexai generate-app-builder -p packages/order
import { ApplicationBuilder } from "@hexaijs/application";
import { CreateOrderCommand } from "./commands/create-order/command";
import { CreateOrderHandler } from "./commands/create-order/handler";
import { SendOrderConfirmation } from "./event-handlers/send-order-confirmation";

export function createApplicationBuilder(): ApplicationBuilder {
    return new ApplicationBuilder()
        .withCommandHandler(CreateOrderCommand, () => new CreateOrderHandler())
        .withEventHandler(() => new SendOrderConfirmation());
}
```

**Key points:**
- `@CommandHandlerMarker(CommandClass)` links handler to command
- `@EventHandlerMarker()` marks event handlers (no argument)
- Run `hexai generate-app-builder -p <context-path>` to regenerate after adding handlers

**See also:** [@hexaijs/plugin-application-builder](./packages/plugin-application-builder/README.md), [@hexaijs/application](./packages/application/README.md)

---

### Generating Contract Types

Share type definitions between backend and frontend.

```typescript
// commands/create-order/command.ts
import { Command } from "@hexaijs/application";
import { PublicCommand } from "@hexaijs/contracts/decorators";

@PublicCommand()
export class CreateOrderCommand extends Command<{
    customerId: string;
    items: Array<{ productId: string; quantity: number }>;
}> {
    static readonly type = "order.create-order";
}

export type CreateOrderResult = {
    orderId: string;
};
```

```typescript
// domain/events.ts
import { DomainEvent } from "@hexaijs/core";
import { PublicEvent } from "@hexaijs/contracts/decorators";

@PublicEvent()
export class OrderPlaced extends DomainEvent<{
    orderId: string;
    customerId: string;
}> {
    static readonly type = "order.order-placed";
}
```

Run the generator:

```bash
hexai generate-contracts -o packages/contracts/src
```

Generated output in `contracts/`:

```typescript
// contracts/order.create-order.ts
export interface CreateOrderCommand {
    customerId: string;
    items: Array<{ productId: string; quantity: number }>;
}

export interface CreateOrderResult {
    orderId: string;
}
```

```typescript
// contracts/order.order-placed.ts
export interface OrderPlacedPayload {
    orderId: string;
    customerId: string;
}
```

**Key points:**
- `@PublicCommand()` and `@PublicEvent()` mark public API surface
- Generator outputs plain TypeScript interfaces
- Frontend imports contracts without backend dependencies

**See also:** [@hexaijs/plugin-contracts-generator](./packages/plugin-contracts-generator/README.md), [@hexaijs/core](./packages/core/README.md)

---

## Status

hexai is under active development. APIs may change.

## License

MIT
