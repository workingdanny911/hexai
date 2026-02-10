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

Both classes accept two type parameters:
- `Payload` - The data the message carries
- `ResultType` - The output type (enables automatic type inference)

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

### ApplicationContext

`ApplicationContext` is a marker interface that your application context must implement. Define your context as a plain interface with the dependencies your handlers need:

```typescript
import { ApplicationContext } from "@hexaijs/application";
import { UnitOfWork } from "@hexaijs/core";

export interface OrderApplicationContext extends ApplicationContext {
    getUnitOfWork(): UnitOfWork;
    getOrderRepository(): OrderRepository;
    getEmailService(): EmailService;
}
```

Event publishing is handled by `ApplicationEventPublisher`, which the `Application` wires automatically. In handlers, publish events through the application's event infrastructure:

```typescript
// Inside a handler — events receive causation/correlation headers automatically
await ctx.publish(
    new OrderPlaced({
        orderId: order.getId().getValue(),
        customerId: command.getPayload().customerId
    })
);
```

### ExecutionScope

`ExecutionScope` provides ALS-based (AsyncLocalStorage) execution context that scopes handler execution with SecurityContext, correlation, and causation data. It replaces the old pattern of passing SecurityContext through message generics.

```typescript
import { ExecutionScope } from "@hexaijs/application";

// Wrap handler execution with security context
await ExecutionScope.run(
    { securityContext: { userId: "user-123", roles: ["admin"] } },
    async () => {
        // Inside this scope, security context is available
        const user = ExecutionScope.requireSecurityContext<UserSecurityContext>();
        console.log(user.userId); // "user-123"
    }
);
```

#### Accessing Scope Data

```typescript
// Optional access (returns undefined if not in scope)
const sc = ExecutionScope.getSecurityContext<UserSecurityContext>();

// Required access (throws if not in scope)
const sc = ExecutionScope.requireSecurityContext<UserSecurityContext>();

// Correlation and causation
const correlation = ExecutionScope.getCorrelation();
const causation = ExecutionScope.getCausation();
```

#### Snapshot and Restore

For async boundaries (e.g., spawning background tasks), capture and restore scope:

```typescript
// Capture current scope
const snapshot = ExecutionScope.snapshot();

// Later, in a different async context
if (snapshot) {
    await ExecutionScope.restore(snapshot, async () => {
        // Security context and trace data restored
        const sc = ExecutionScope.requireSecurityContext();
    });
}
```

#### Parent Scope Inheritance

Nested `run()` calls inherit from the parent scope. Only explicitly provided fields override parent values:

```typescript
await ExecutionScope.run({ securityContext: user }, async () => {
    await ExecutionScope.run({ correlation: trace }, async () => {
        // securityContext: inherited from parent (user)
        // correlation: overridden (trace)
    });
});
```

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
| `Command<P, O>` | Base class for commands with payload and output type |
| `Query<P, O>` | Base class for queries with payload and output type |
| `ExecutionScope` | ALS-based execution context for security context, correlation, and causation |
| `ExecutionScopeSnapshot` | Immutable snapshot of execution scope data |
| `CommandHandler<I, Ctx>` | Interface for command handlers (output inferred from command) |
| `QueryHandler<I, Ctx>` | Interface for query handlers (output inferred from query) |
| `EventHandler<E, Ctx>` | Interface for event handlers |
| `ApplicationContext` | Marker interface for application contexts |
| `Result<R, E>` | Union type of `SuccessResult` or `ErrorResult` |
| `SelectorBasedEventHandler` | Base class for decorator-based event routing |
| `SimpleCompositeApplication` | Composes multiple applications by message prefix |
| `CommandInterceptor` | Interceptor type for commands |
| `QueryInterceptor` | Interceptor type for queries |
| `EventInterceptor` | Interceptor type for events |
| `Interceptor` | Interceptor type for all messages |

## Migration Guide

### From v0.4.0 to v0.5.0

This version replaces message-level SecurityContext with ALS-based `ExecutionScope` and simplifies the application context.

#### Command and Query

**Before (v0.4.x)**:
```typescript
class MyCommand extends Command<Payload, ResultType, MySecurityContext> {}
const sc = command.getSecurityContext(); // from message
```

**After (v0.5.0)**:
```typescript
class MyCommand extends Command<Payload, ResultType> {}
const sc = ExecutionScope.requireSecurityContext<MySecurityContext>(); // from ALS
```

#### SecurityContext Access in Handlers

**Before (v0.4.x)**:
```typescript
async execute(command: MyCommand, ctx: MyContext) {
    const user = command.getSecurityContext();
}
```

**After (v0.5.0)**:
```typescript
import { ExecutionScope } from "@hexaijs/application";

async execute(command: MyCommand, ctx: MyContext) {
    const user = ExecutionScope.requireSecurityContext<UserSecurityContext>();
}
```

#### ApplicationContext

`AbstractApplicationContext` replaced with `ApplicationContext` marker interface. Define contexts as plain interfaces instead of extending an abstract class.

#### Quick Migration Checklist

- [ ] Replace `Command<P, O, SC>` with `Command<P, O>`
- [ ] Replace `Query<P, O, SC>` with `Query<P, O>`
- [ ] Replace `command.getSecurityContext()` / `command.withSecurityContext()` with `ExecutionScope` methods
- [ ] Remove `MessageWithAuth` and `MessageWithAuthOptions` imports
- [ ] Remove `clone()`, `deriveFrom()`, `onEnter()`, `onExit()`, `enterCommandExecutionScope()` overrides from ApplicationContext subclasses
- [ ] Add `@hexaijs/contracts` `^0.1.0` as peer dependency

### From v0.3.1 to v0.4.0

This version promotes correlation/causation tracing to `Message`-level API in `@hexaijs/core`.

#### Correlation/Causation Headers

**Before (v0.3.x)** - using raw headers:
```typescript
const cmd = new MyCommand(payload)
    .withHeader("correlationId", "corr-123")
    .withHeader("correlationType", "HttpRequest");
```

**After (v0.4.0)** - using typed methods:
```typescript
const cmd = new MyCommand(payload)
    .withCorrelation({ id: "corr-123", type: "HttpRequest" });

cmd.getCorrelation();  // { id: "corr-123", type: "HttpRequest" }
```

The utility functions (`causationOf`, `correlationOf`, `setCausationOf`, `setCorrelationOf`, `asTrace`) and `MessageTrace` type from `messaging-support` have been **removed**. Use `Message` methods and import `MessageTrace` from `@hexaijs/core`.

#### Quick Migration Checklist

- [ ] Replace `import { MessageTrace } from "@hexaijs/application"` with `import { MessageTrace } from "@hexaijs/core"`
- [ ] Replace `import { asTrace, causationOf, ... } from "@hexaijs/application"` with `Message` methods
- [ ] Replace `withHeader("correlationId", ...)` / `withHeader("correlationType", ...)` with `withCorrelation({ id, type })`
- [ ] Replace `withHeader("causationId", ...)` / `withHeader("causationType", ...)` with `withCausation({ id, type })`
- [ ] Replace `getHeader("correlationId")` with `getCorrelation()?.id`
- [ ] Replace `causationOf(msg)` with `msg.getCausation()`
- [ ] Replace `correlationOf(msg)` with `msg.getCorrelation()`
- [ ] Replace `asTrace(msg)` with `msg.asTrace()`
- [ ] Update `@hexaijs/core` peer dependency to `^0.6.0`

### From v0.2.0 to v0.3.0

> **Note**: `MessageWithAuth` and constructor options described here were removed in v0.5.0. See v0.4.0 → v0.5.0 migration guide.

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

> **Note**: The `SecurityContext` (SC) generic described here was removed in v0.5.0. Command is now `Command<P, O>`. See v0.4.0 → v0.5.0 migration guide.

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
