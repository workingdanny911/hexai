# @hexaijs/application

> Application layer infrastructure for building CQRS applications with hexagonal architecture

## Overview

`@hexaijs/application` provides the application layer components for building CQRS (Command Query Responsibility Segregation) applications. It bridges the gap between your domain model and external interfaces (HTTP, CLI, message queues) by providing a structured way to handle commands, queries, and events.

The package centers around three key patterns:

1. **Application** - A facade that routes messages to their handlers and manages execution context
2. **ApplicationContext** - Scopes handler execution with transactional boundaries and event publishing
3. **Interceptors** - Cross-cutting concerns that wrap message handling (logging, tracing, authorization)

These components work together to ensure each command/query executes in isolation with proper transaction management, while events flow through the system with causation and correlation tracking.

## Installation

```bash
npm install @hexaijs/application
```

## Core Concepts

### Command and Query

`Command` and `Query` extend the core `Message` class to represent different intents. Commands change state; queries read state.

```typescript
import { Command, Query } from "@hexaijs/application";

// Command - changes state
export class CreateOrderCommand extends Command<{
    customerId: string;
    items: { productId: string; quantity: number }[];
}> {
    static readonly type = "order.create-order";
}

// Query - reads state
export class GetOrderQuery extends Query<{
    orderId: string;
}> {
    static readonly type = "order.get-order";
}
```

Both support security contexts for authorization:

```typescript
// Attach security context
const command = new CreateOrderCommand({
    customerId: "customer-123",
    items: []
}).withSecurityContext({ userId: "user-456", roles: ["admin"] });

// Access in handler
const user = command.getSecurityContext();
```

### CommandHandler and QueryHandler

Handlers implement the `execute` method to process messages:

```typescript
import { CommandHandler, QueryHandler } from "@hexaijs/application";

interface OrderContext {
    getOrderRepository(): OrderRepository;
}

class CreateOrderHandler implements CommandHandler<
    CreateOrderCommand,
    { orderId: string },
    OrderContext
> {
    async execute(
        command: CreateOrderCommand,
        ctx: OrderContext
    ): Promise<{ orderId: string }> {
        const repository = ctx.getOrderRepository();
        const order = Order.create(command.getPayload());
        await repository.add(order);
        return { orderId: order.getId().getValue() };
    }
}

class GetOrderHandler implements QueryHandler<
    GetOrderQuery,
    OrderDto,
    OrderContext
> {
    async execute(
        query: GetOrderQuery,
        ctx: OrderContext
    ): Promise<OrderDto> {
        const repository = ctx.getOrderRepository();
        const order = await repository.get(query.getPayload().orderId);
        return toDto(order);
    }
}
```

### EventHandler

Event handlers react to domain events. The `canHandle` method filters which events the handler processes:

```typescript
import { Message } from "@hexaijs/core";
import { EventHandler } from "@hexaijs/application";

class SendOrderConfirmationEmail implements EventHandler<OrderPlaced, OrderContext> {
    canHandle(message: Message): boolean {
        return message.getMessageType() === OrderPlaced.getType();
    }

    async handle(event: OrderPlaced, ctx: OrderContext): Promise<void> {
        const payload = event.getPayload();
        await ctx.getEmailService().send({
            to: payload.customerEmail,
            template: "order-confirmation",
            data: { orderId: payload.orderId }
        });
    }
}
```

### ApplicationBuilder

`ApplicationBuilder` assembles handlers and context into an `Application` using a fluent API:

```typescript
import { ApplicationBuilder } from "@hexaijs/application";

const application = new ApplicationBuilder()
    .withApplicationContext(new OrderApplicationContext())
    .withCommandHandler(CreateOrderCommand, () => new CreateOrderHandler())
    .withCommandHandler(CancelOrderCommand, () => new CancelOrderHandler())
    .withQueryHandler(GetOrderQuery, () => new GetOrderHandler())
    .withEventHandler(() => new SendOrderConfirmationEmail())
    .build();
```

Each handler is registered with a factory function. This allows fresh handler instances per request, preventing state leakage between requests.

### Application

The `Application` interface provides three methods for dispatching messages:

```typescript
import { Application, Result } from "@hexaijs/application";

// Execute commands
const result: Result<{ orderId: string }> = await application.executeCommand(
    new CreateOrderCommand({ customerId: "c-123", items: [] })
);

// Execute queries
const orderResult: Result<OrderDto> = await application.executeQuery(
    new GetOrderQuery({ orderId: "order-456" })
);

// Handle events (typically called by infrastructure)
await application.handleEvent(orderPlacedEvent);
```

### Result

All operations return a `Result` type that is either `SuccessResult` or `ErrorResult`:

```typescript
const result = await application.executeCommand(command);

if (result.isSuccess) {
    console.log("Order created:", result.data.orderId);
}

if (result.isError) {
    console.error("Failed:", result.error.message);
}

// Or throw on error
const data = result.getOrThrow();
```

### AbstractApplicationContext

Extend `AbstractApplicationContext` to define your application's dependencies. The context provides event publishing and hooks for transaction management:

```typescript
import { AbstractApplicationContext } from "@hexaijs/application";
import { UnitOfWork } from "@hexaijs/core";

export abstract class OrderApplicationContext extends AbstractApplicationContext {
    abstract getUnitOfWork(): UnitOfWork;
    abstract getOrderRepository(): OrderRepository;
    abstract getEmailService(): EmailService;
}
```

The context provides `publish()` for emitting domain events:

```typescript
// Inside a handler
await ctx.publish(
    new OrderPlaced({
        orderId: order.getId().getValue(),
        customerId: command.getPayload().customerId
    })
);
```

Events published through the context automatically receive causation and correlation headers, enabling distributed tracing.

## Interceptors

Interceptors wrap message handling for cross-cutting concerns. They follow a middleware pattern:

```typescript
import { CommandInterceptor, CommandInterceptionContext, Result } from "@hexaijs/application";

const loggingInterceptor: CommandInterceptor = async (
    ctx: CommandInterceptionContext,
    next: () => Promise<Result<unknown>>
): Promise<Result<unknown>> => {
    console.log("Executing:", ctx.message.getMessageType());
    const start = Date.now();

    const result = await next();

    console.log(`Completed in ${Date.now() - start}ms`);
    return result;
};

// Register with builder
const app = new ApplicationBuilder()
    .withApplicationContext(context)
    .withCommandHandler(CreateOrderCommand, () => new CreateOrderHandler())
    .withCommandInterceptor(loggingInterceptor)
    .build();
```

Four interceptor types are available:

| Type | Applies To |
|------|------------|
| `CommandInterceptor` | Command execution only |
| `QueryInterceptor` | Query execution only |
| `EventInterceptor` | Event handling only |
| `Interceptor` | All message types |

## Advanced Patterns

### SelectorBasedEventHandler

For handlers that respond to multiple event types, use `SelectorBasedEventHandler` with the `@When` decorator:

```typescript
import { Message } from "@hexaijs/core";
import { SelectorBasedEventHandler, When, eventTypeMatches } from "@hexaijs/application";

class OrderEventHandler extends SelectorBasedEventHandler<Message, OrderContext> {
    @When(eventTypeMatches(OrderPlaced.getType()))
    async onOrderPlaced(event: OrderPlaced, ctx: OrderContext): Promise<void> {
        // Handle order placed
    }

    @When(eventTypeMatches(OrderCancelled.getType()))
    async onOrderCancelled(event: OrderCancelled, ctx: OrderContext): Promise<void> {
        // Handle order cancelled
    }
}
```

The `eventTypeMatches` helper supports strings, arrays, and regex patterns:

```typescript
@When(eventTypeMatches("order.order-placed"))
@When(eventTypeMatches(["order.order-placed", "order.order-updated"]))
@When(eventTypeMatches(/^order\./))
```

### SimpleCompositeApplication

Compose multiple bounded context applications into one:

```typescript
import { SimpleCompositeApplication } from "@hexaijs/application";

const compositeApp = new SimpleCompositeApplication({
    "order.": orderApplication,      // handles order.* messages
    "inventory.": inventoryApplication,
    "shipping.": shippingApplication,
});

// Routes to appropriate application based on message type prefix
await compositeApp.executeCommand(new CreateOrderCommand(...));
```

For event handling across bounded contexts, provide a `UnitOfWork` to ensure all handlers execute in the same transaction:

```typescript
compositeApp.setUnitOfWork(unitOfWork);
await compositeApp.handleEvent(event);
```

## API Highlights

| Export | Description |
|--------|-------------|
| `Application` | Interface for command/query execution and event handling |
| `ApplicationBuilder` | Fluent builder for assembling applications |
| `Command<P, SC>` | Base class for commands with payload and security context |
| `Query<P, SC>` | Base class for queries with payload and security context |
| `CommandHandler<I, O, Ctx>` | Interface for command handlers |
| `QueryHandler<I, O, Ctx>` | Interface for query handlers |
| `EventHandler<E, Ctx>` | Interface for event handlers |
| `AbstractApplicationContext` | Base class for application contexts |
| `Result<R, E>` | Union type of `SuccessResult` or `ErrorResult` |
| `SelectorBasedEventHandler` | Base class for decorator-based event routing |
| `SimpleCompositeApplication` | Composes multiple applications by message prefix |
| `CommandInterceptor` | Interceptor type for commands |
| `QueryInterceptor` | Interceptor type for queries |
| `EventInterceptor` | Interceptor type for events |
| `Interceptor` | Interceptor type for all messages |

## See Also

- [@hexaijs/core](../core/README.md) - Core domain primitives this package builds upon
- [@hexaijs/postgres](../postgres/README.md) - PostgreSQL implementation for ApplicationContext
- [@hexaijs/plugin-application-builder](../plugin-application-builder/README.md) - Decorators for automatic handler registration
