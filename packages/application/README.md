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

Both classes accept three type parameters:
- `Payload` - The data the message carries
- `ResultType` - The output type (enables automatic type inference)
- `SecurityContext` - Optional security context type (defaults to `unknown`)

```typescript
import { Command, Query } from "@hexaijs/application";

// Command - changes state, returns { orderId: string }
export class CreateOrderCommand extends Command<
    { customerId: string; items: { productId: string; quantity: number }[] },
    { orderId: string }
> {
    static readonly type = "order.create-order";
}

// Query - reads state, returns OrderDto
export class GetOrderQuery extends Query<
    { orderId: string },
    OrderDto
> {
    static readonly type = "order.get-order";
}
```

With output types declared, `executeCommand` and `executeQuery` automatically infer return types:

```typescript
const result = await app.executeCommand(new CreateOrderCommand({
    customerId: "c-123",
    items: []
}));
// result type: Result<{ orderId: string }> - automatically inferred!

const orderResult = await app.executeQuery(new GetOrderQuery({ orderId: "o-456" }));
// orderResult type: Result<OrderDto> - automatically inferred!
```

Both support security contexts for authorization. To get typed security context access, specify it as the third type parameter:

```typescript
// Define a security context type
interface UserSecurityContext {
    userId: string;
    roles: string[];
}

// Command with typed security context (third parameter)
export class SecureCreateOrderCommand extends Command<
    { customerId: string; items: { productId: string; quantity: number }[] },
    { orderId: string },
    UserSecurityContext
> {
    static readonly type = "order.secure-create-order";
}

// Attach security context
const command = new SecureCreateOrderCommand({
    customerId: "customer-123",
    items: []
}).withSecurityContext({ userId: "user-456", roles: ["admin"] });

// Access in handler - type is inferred from Command's third parameter
const user = command.getSecurityContext();  // UserSecurityContext
```

#### MessageWithAuthOptions

Both `Command` and `Query` constructors accept an optional `MessageWithAuthOptions` object:

```typescript
import { MessageWithAuthOptions } from "@hexaijs/application";

interface MessageWithAuthOptions<SecCtx> extends MessageOptions {
    securityContext?: SecCtx;
}

// Pass security context via options
const command = new SecureCreateOrderCommand(
    { customerId: "customer-123", items: [] },
    { securityContext: { userId: "user-456", roles: ["admin"] } }
);

// Equivalent to using withSecurityContext():
const command2 = new SecureCreateOrderCommand(
    { customerId: "customer-123", items: [] }
).withSecurityContext({ userId: "user-456", roles: ["admin"] });
```

### CommandHandler and QueryHandler

Handlers implement the `execute` method to process messages. The output type is automatically inferred from the Command/Query's `ResultType` parameter:

```typescript
import { CommandHandler, QueryHandler } from "@hexaijs/application";

interface OrderContext {
    getOrderRepository(): OrderRepository;
}

// Handler infers output type from CreateOrderCommand's ResultType ({ orderId: string })
class CreateOrderHandler implements CommandHandler<CreateOrderCommand, OrderContext> {
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

// Handler infers output type from GetOrderQuery's ResultType (OrderDto)
class GetOrderHandler implements QueryHandler<GetOrderQuery, OrderContext> {
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

You can also extract output types directly from Command/Query classes using indexed access:

```typescript
type CreateOrderOutput = CreateOrderCommand['ResultType'];  // { orderId: string }
type GetOrderOutput = GetOrderQuery['ResultType'];          // OrderDto
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
| `Command<P, O, SC>` | Base class for commands with payload, output type, and security context |
| `MessageWithAuthOptions<SC>` | Options for Command/Query constructor (`{ headers?, securityContext? }`) |
| `Query<P, O, SC>` | Base class for queries with payload, output type, and security context |
| `CommandHandler<I, Ctx>` | Interface for command handlers (output inferred from command) |
| `QueryHandler<I, Ctx>` | Interface for query handlers (output inferred from query) |
| `EventHandler<E, Ctx>` | Interface for event handlers |
| `AbstractApplicationContext` | Base class for application contexts |
| `Result<R, E>` | Union type of `SuccessResult` or `ErrorResult` |
| `SelectorBasedEventHandler` | Base class for decorator-based event routing |
| `SimpleCompositeApplication` | Composes multiple applications by message prefix |
| `CommandInterceptor` | Interceptor type for commands |
| `QueryInterceptor` | Interceptor type for queries |
| `EventInterceptor` | Interceptor type for events |
| `Interceptor` | Interceptor type for all messages |

## Migration Guide

### From v0.2.0 to v0.3.0

This version changes the constructor pattern for `Command`, `Query`, and `MessageWithAuth` from positional parameters to an options object.

#### Constructor Pattern

**Before (v0.2.x)**:
```typescript
const command = new CreateOrderCommand(payload, headers, securityContext);
```

**After (v0.3.0)**:
```typescript
const command = new CreateOrderCommand(payload, {
    headers,
    securityContext,
});
```

#### Clone Methods

`clone()`, `cloneWithHeaders()`, and `withHeader()` overrides have been removed from `MessageWithAuth`. These methods are now inherited from the `Message` base class in `@hexaijs/core`. No migration needed — the public API (`withHeader()`, `withSecurityContext()`) remains the same.

#### Quick Migration Checklist

- [ ] Update `new Command(payload, headers, sc)` to `new Command(payload, { headers, securityContext: sc })`
- [ ] Update `new Query(payload, headers, sc)` to `new Query(payload, { headers, securityContext: sc })`
- [ ] Remove any direct calls to `clone()` or `cloneWithHeaders()` on `MessageWithAuth` (use `withHeader()` / `withSecurityContext()` instead)

### From v0.1.x to v0.2.0

This version introduces automatic output type inference with breaking changes to type parameters.

#### Command and Query

**Before (v0.1.x)**:
```typescript
// Second type parameter was SecurityContext
class MyCommand extends Command<Payload, MySecurityContext> {}
```

**After (v0.2.0)**:
```typescript
// Second type parameter is now ResultType, SecurityContext moves to third
class MyCommand extends Command<Payload, ResultType, MySecurityContext> {}

// If you don't need custom SecurityContext, just use two parameters:
class MyCommand extends Command<Payload, ResultType> {}
```

#### CommandHandler and QueryHandler

**Before (v0.1.x)**:
```typescript
class MyHandler implements CommandHandler<MyCommand, OutputType, Context> {
    async execute(cmd: MyCommand, ctx: Context): Promise<OutputType> { ... }
}
```

**After (v0.2.0)**:
```typescript
// Output type is automatically inferred from MyCommand's ResultType
class MyHandler implements CommandHandler<MyCommand, Context> {
    async execute(cmd: MyCommand, ctx: Context): Promise<OutputType> { ... }
}
```

#### Security Context Access

**Before (v0.1.x)**:
```typescript
// SC was the second type parameter
class MyCommand extends Command<Payload, MySecurityContext> {}
const sc = command.getSecurityContext();  // MySecurityContext
```

**After (v0.2.0)**:
```typescript
// SC is now the third type parameter
class MyCommand extends Command<Payload, ResultType, MySecurityContext> {}
const sc = command.getSecurityContext();  // MySecurityContext (same usage)
```

#### Quick Migration Checklist

- [ ] Update `Command<P, SC>` to `Command<P, O, SC>` or `Command<P, O>` (SC moves to 3rd position)
- [ ] Update `Query<P, SC>` to `Query<P, O, SC>` or `Query<P, O>` (SC moves to 3rd position)
- [ ] Remove `O` parameter from `CommandHandler<I, O, Ctx>` → `CommandHandler<I, Ctx>`
- [ ] Remove `O` parameter from `QueryHandler<I, O, Ctx>` → `QueryHandler<I, Ctx>`

## See Also

- [@hexaijs/core](../core/README.md) - Core domain primitives this package builds upon
- [@hexaijs/postgres](../postgres/README.md) - PostgreSQL implementation for ApplicationContext
- [@hexaijs/plugin-application-builder](../plugin-application-builder/README.md) - Decorators for automatic handler registration
