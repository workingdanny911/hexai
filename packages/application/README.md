# @hexaijs/application

> The application layer: route commands, queries, and events to their handlers

## Overview

`@hexaijs/application` sits between your adapters (HTTP, CLI, message consumers) and your domain. You register a handler for each command and query, and handlers for events. The resulting application:

- finds the handler for each message and calls it with your application context;
- returns a `Result` (success or error) instead of throwing;
- runs interceptors around each call, for logging, authorization, and similar concerns;
- keeps the security context, correlation, and causation of the current call in an execution scope.

The application does not open transactions or publish events by itself. You decide where the unit of work's `scope()` and the event publisher go; [Wiring the Unit of Work and Event Publishing](#wiring-the-unit-of-work-and-event-publishing) shows how.

## Installation

```bash
npm install @hexaijs/application @hexaijs/core @hexaijs/contracts
```

| Peer dependency | Needed for |
|-----------------|------------|
| `@hexaijs/core` | Always |
| `@hexaijs/contracts` | Always. It defines `Command` and `Query`, which this package re-exports. |
| `pino` | Optional. Only for `@hexaijs/application/pino`. |
| `pino-pretty` | Optional. Only for `createLogger({ pretty: true })`. |

The supported version ranges are in this package's `package.json`.

The package is ESM-only and runs on Node.js: the execution scope uses `node:async_hooks`.

## Quick Start

```typescript
import { randomUUID } from "node:crypto";
import {
    ApplicationBuilder,
    Command,
    type CommandHandler,
} from "@hexaijs/application";

class RegisterUser extends Command<{ email: string }, { userId: string }> {
    static readonly type = "user.register-user";
}

interface UserContext {
    users: Map<string, string>;
}

class RegisterUserHandler implements CommandHandler<RegisterUser, UserContext> {
    async execute(command: RegisterUser, ctx: UserContext) {
        const userId = randomUUID();
        ctx.users.set(userId, command.getPayload().email);
        return { userId };
    }
}

const app = new ApplicationBuilder()
    .withApplicationContext({ users: new Map<string, string>() })
    .withCommandHandler(RegisterUser, () => new RegisterUserHandler())
    .build();

const result = await app.executeCommand(new RegisterUser({ email: "ada@example.com" }));

if (result.isSuccess) {
    console.log("registered", result.data.userId);
} else {
    console.error(result.error.message);
}
```

## Core Concepts

### Command and Query

A command asks the application to change state. A query asks it to read state. Both are messages (see [Messages in `@hexaijs/core`](../core/README.md#messages)) and take two type parameters:

- `Payload`: the data the message carries.
- `ResultType`: what its handler returns. `executeCommand` and `executeQuery` infer their result type from it.

`Command` and `Query` are defined in `@hexaijs/contracts` and re-exported here.

```typescript
import { Command, Query } from "@hexaijs/application";

type OrderDto = { orderId: string; status: string };

class CreateOrderCommand extends Command<
    { customerId: string; items: { productId: string; quantity: number }[] },
    { orderId: string }
> {
    static readonly type = "order.create-order";
}

class GetOrderQuery extends Query<{ orderId: string }, OrderDto> {
    static readonly type = "order.get-order";
}

const created = await app.executeCommand(
    new CreateOrderCommand({ customerId: "c-123", items: [] })
);
// created: Result<{ orderId: string }>

const order = await app.executeQuery(new GetOrderQuery({ orderId: "o-456" }));
// order: Result<OrderDto>

type CreateOrderOutput = CreateOrderCommand["ResultType"]; // { orderId: string }
```

Give every command and query a unique static `type`. The application registers and finds handlers by that type.

### Application Context

The application context is the object that gives handlers their dependencies: repositories, the unit of work, an event publisher, services. The application passes the same object to every handler as the second argument and never calls anything on it.

`ApplicationContext` is an empty interface, so any object fits. Extend it to document what your handlers get:

```typescript
import type { ApplicationContext } from "@hexaijs/application";

interface OrderContext extends ApplicationContext {
    getOrderRepository(): OrderRepository;
    getEmailService(): EmailService;
}
```

### CommandHandler and QueryHandler

A handler implements `execute(message, ctx)`. Its return type comes from the message's `ResultType`. `ctx` is your [application context](#application-context).

```typescript
import type { CommandHandler, QueryHandler } from "@hexaijs/application";

class CreateOrderHandler implements CommandHandler<CreateOrderCommand, OrderContext> {
    async execute(command: CreateOrderCommand, ctx: OrderContext): Promise<{ orderId: string }> {
        const order = await ctx.getOrderRepository().create(command.getPayload());
        return { orderId: order.orderId };
    }
}

class GetOrderHandler implements QueryHandler<GetOrderQuery, OrderContext> {
    async execute(query: GetOrderQuery, ctx: OrderContext): Promise<OrderDto> {
        return ctx.getOrderRepository().get(query.getPayload().orderId);
    }
}
```

You register a factory for each handler. The application calls the factory for every command or query, so a handler instance never serves two calls.

### EventHandler

An event handler reacts to events. `canHandle(message)` decides whether it takes an event, and `handle(event, ctx)` does the work.

```typescript
import type { Message } from "@hexaijs/core";
import type { EventHandler } from "@hexaijs/application";

class SendOrderConfirmation implements EventHandler<OrderPlaced, OrderContext> {
    canHandle(message: Message): boolean {
        return message.getMessageType() === OrderPlaced.getType();
    }

    async handle(event: OrderPlaced, ctx: OrderContext): Promise<void> {
        await ctx.getEmailService().sendOrderConfirmation(event.getPayload().orderId);
    }
}
```

Unlike command and query handlers, event handlers are created once: `withEventHandler()` calls the factory when you register it and reuses that instance for every event. Keep event handlers free of per-event state.

`handleEvent(event)` runs every handler whose `canHandle()` returns `true`, all at once. See [Event Fan-out](#event-fan-out) for how it waits for them and reports failures. To route several event types to methods of one class, see [SelectorBasedEventHandler](#selectorbasedeventhandler).

### ApplicationBuilder

`ApplicationBuilder` assembles an `Application`:

```typescript
import { ApplicationBuilder } from "@hexaijs/application";

const app = new ApplicationBuilder()
    .withApplicationContext(context)
    .withCommandHandler(CreateOrderCommand, () => new CreateOrderHandler())
    .withQueryHandler(GetOrderQuery, () => new GetOrderHandler())
    .withEventHandler(() => new SendOrderConfirmation())
    .build();
```

| Method | Notes |
|--------|-------|
| `withApplicationContext(context)` | Required. `build()` throws without it. |
| `withCommandHandler(CommandClass, factory)` | One handler per command type. Registering a second one for the same type throws. |
| `withQueryHandler(QueryClass, factory)` | One handler per query type, as above. |
| `withEventHandler(factory, name?)` | Calls `factory` immediately. A `name`, when given, must be unique. |
| `withCommandInterceptor`, `withQueryInterceptor`, `withEventInterceptor`, `withInterceptor` | See [Interceptors](#interceptors). |
| `withErrorTransformer(transformer)` | See [Errors](#errors). |
| `build()` | Returns the `Application`. |

### Application

`Application` has three methods. Each returns a `Promise` of a `Result`.

| Method | What it does |
|--------|--------------|
| `executeCommand(command)` | Runs the command's handler. |
| `executeQuery(query)` | Runs the query's handler. |
| `handleEvent(event)` | Runs every event handler that can handle the event. Usually called by your event infrastructure, such as an event publisher subscriber or a message consumer. |

### Result

Every call resolves to a `Result`, either a `SuccessResult` or an `ErrorResult`:

```typescript
const result = await app.executeCommand(command);

if (result.isSuccess) {
    console.log("Order created:", result.data.orderId);
} else {
    console.error("Failed:", result.error.message);
}

// Or get the data, throwing the error on failure:
const { orderId } = result.getOrThrow();
```

### Errors

When a handler throws, the call resolves to an `ErrorResult` whose `error` is an `ApplicationError`:

- An `ApplicationError` thrown by the handler is passed through unchanged.
- Any other error goes through the error transformer. The default one wraps it in an `ApplicationError` with the same message, the original error as `cause`, and `data.context` holding the message (and, for commands and queries, the handler).
- A command or query with no registered handler resolves to an `ErrorResult` holding a `HandlerNotFound` error, which extends `ApplicationError`.

`ApplicationError` takes `{ code?, message?, cause?, data? }` and exposes `code` and `data`. Throw it from a handler to choose the code and data yourself, or replace the transformer:

```typescript
import { ApplicationBuilder, ApplicationError } from "@hexaijs/application";
import { InvariantNotSatisfiedError } from "@hexaijs/core";

const app = new ApplicationBuilder()
    .withApplicationContext(context)
    .withErrorTransformer((error, { message }) =>
        new ApplicationError({
            code: error instanceof InvariantNotSatisfiedError ? error.code : "INTERNAL",
            message: error.message,
            cause: error,
            data: { messageType: message.getMessageType() },
        })
    )
    .withCommandHandler(CreateOrderCommand, () => new CreateOrderHandler())
    .build();
```

Some failures reject the returned promise instead of resolving to an `ErrorResult`: an error thrown by an interceptor, and a failure of the unit of work inside `SimpleCompositeApplication.handleEvent()`.

### ExecutionScope

`ExecutionScope` holds data about the current call: the security context (who is calling), the correlation, and the causation (see [Correlation and Causation](../core/README.md#correlation-and-causation)). It keeps them in Node's `AsyncLocalStorage`, which makes a value available to everything a function awaits, without passing it as an argument.

The application sets part of it. `executeCommand`, `executeQuery`, and `handleEvent` run the handler inside `ExecutionScope.run()` with:

- causation: the message being handled (`message.asTrace()`);
- correlation: the message's correlation header, or none;
- security context: inherited from the caller's scope.

So the adapter that receives a request sets the security context, by running the call inside a scope:

```typescript
import { ExecutionScope } from "@hexaijs/application";

type UserSecurityContext = { userId: string; roles: string[] };

async function createOrderFor(user: UserSecurityContext, customerId: string) {
    return ExecutionScope.run({ securityContext: user }, () =>
        app.executeCommand(new CreateOrderCommand({ customerId, items: [] }))
    );
}
```

Handlers, and anything they call, read it back:

| Method | Returns |
|--------|---------|
| `ExecutionScope.getSecurityContext<T>()` | The security context, or `undefined` |
| `ExecutionScope.requireSecurityContext<T>()` | The security context. Throws when there is none. |
| `ExecutionScope.getCorrelation()` | The correlation `MessageTrace`, or `undefined` |
| `ExecutionScope.getCausation()` | The causation `MessageTrace`, or `undefined` |
| `ExecutionScope.current()` | All three fields, or `undefined` outside any scope |

A nested `run()` inherits every field it does not pass. A field passed explicitly, even as `undefined`, replaces the parent's value.

```typescript
await ExecutionScope.run({ securityContext: user }, async () => {
    await ExecutionScope.run({ correlation: requestTrace }, async () => {
        // securityContext: user, inherited
        // correlation: requestTrace
    });
});
```

For work that leaves the async call chain, such as a job queued for later, take a snapshot and restore it:

```typescript
const snapshot = ExecutionScope.snapshot(); // undefined outside any scope

if (snapshot) {
    await ExecutionScope.restore(snapshot, async () => {
        // the security context, correlation, and causation from the snapshot
    });
}
```

## Usage

### Wiring the Unit of Work and Event Publishing

A unit of work groups a handler's writes into one transaction; [`@hexaijs/core`](../core/README.md#unit-of-work-and-transactions) defines it. An event publisher hands the events a handler raises to whoever listens. The application wires neither:

| Step | Who does it |
|------|-------------|
| Run the handler inside an `ExecutionScope` with causation and correlation | The application built by `ApplicationBuilder` |
| Open a unit-of-work `scope()`, which is the transaction | You, usually in the handler. Only [`SimpleCompositeApplication.handleEvent()`](#simplecompositeapplication) opens one itself. |
| Create an `ApplicationEventPublisher` and put it in the context | You |
| Deliver published events to the application's event handlers | You, by subscribing `app.handleEvent` to the publisher |

The example below wires all of it. `Order` and `OrderId` come from the [`@hexaijs/core` quick start](../core/README.md#quick-start), and `SendOrderConfirmation` is the event handler from [EventHandler](#eventhandler).

```typescript
import { randomUUID } from "node:crypto";
import {
    ApplicationBuilder,
    ApplicationEventPublisher,
    Command,
    type ApplicationContext,
    type CommandHandler,
} from "@hexaijs/application";
import type { EventPublisher, Message, Repository, UnitOfWork } from "@hexaijs/core";

interface OrderContext extends ApplicationContext {
    getUnitOfWork(): UnitOfWork;
    getOrderRepository(): Repository<Order>;
    getEventPublisher(): EventPublisher<Message>;
    getEmailService(): EmailService;
}

class PlaceOrder extends Command<{ customerId: string }, { orderId: string }> {
    static readonly type = "order.place-order";
}

class PlaceOrderHandler implements CommandHandler<PlaceOrder, OrderContext> {
    async execute(command: PlaceOrder, ctx: OrderContext): Promise<{ orderId: string }> {
        return ctx.getUnitOfWork().scope(async () => {
            const order = Order.place(new OrderId(randomUUID()), command.getPayload().customerId);
            await ctx.getOrderRepository().add(order);
            await ctx.getEventPublisher().publish(...order.flushEvents());
            return { orderId: order.getId().getValue() };
        });
    }
}

const eventPublisher = new ApplicationEventPublisher();

const context: OrderContext = {
    getUnitOfWork: () => unitOfWork,
    getOrderRepository: () => orderRepository,
    getEventPublisher: () => eventPublisher,
    getEmailService: () => emailService,
};

const app = new ApplicationBuilder()
    .withApplicationContext(context)
    .withCommandHandler(PlaceOrder, () => new PlaceOrderHandler())
    .withEventHandler(() => new SendOrderConfirmation())
    .build();

eventPublisher.subscribe(async (event) => {
    const result = await app.handleEvent(event);
    result.getOrThrow();
});
```

What happens on `app.executeCommand(new PlaceOrder({ customerId: "c-1" }))`:

1. The application runs `PlaceOrderHandler` inside an execution scope whose causation is the `PlaceOrder` command.
2. The handler opens a `scope()`. The repository write and everything below run inside it.
3. `publish()` sets each event's causation to the command, and its correlation to the command's correlation (or to the command itself when it has none). Then it calls the subscriber.
4. The subscriber runs the application's event handlers while the command's scope is still open. A `scope()` they open on the same unit of work joins the command's transaction when it uses `Propagation.EXISTING`, the default in `@hexaijs/postgres`.
5. `getOrThrow()` turns a failed event handler into a rejection of `publish()`. The command handler then throws, the transaction rolls back, and `executeCommand` resolves to an `ErrorResult`. Log the result instead of calling `getOrThrow()` if a failed event handler should not fail the command. With `@hexaijs/postgres`, though, a failed `scope()` that joined the transaction aborts it either way.

Handlers depend on the core `EventPublisher<Message>` contract, so tests can pass any object with a `publish()` method.

With [`@hexaijs/postgres`](../postgres/README.md), the unit of work comes from `createPostgresUnitOfWork(pool)`, and a repository takes `unitOfWork.db` once (for example `new PostgresOrderRepository(unitOfWork.db)`). Each query then runs in the transaction of the scope it is called in. The same package provides `attachPostgresEventStoreSink()`, which subscribes to an `ApplicationEventPublisher` and appends the published events to the event store inside the publishing transaction.

You can also open the scope in a command interceptor. Note that `next()` resolves to an `ErrorResult` instead of throwing when the handler fails, so such an interceptor must turn an `ErrorResult` into a rejection inside `scope()`; otherwise the transaction commits the failed command's writes.

### ApplicationEventPublisher

`ApplicationEventPublisher` implements the core `SubscribableEventPublisher<Message>` contract. `subscribe(subscriber)` adds a subscriber and returns a function that removes it.

`publish(...events)` handles the events one after another. For each event, it:

1. sets headers from the current execution scope, when the scope has a causation: `causation` becomes the scope's causation, and `correlation` the scope's correlation, or the causation when there is none;
2. passes the scope's security context to the event's `withSecurityContext()` method, when the scope has one and the event class defines that method;
3. calls every subscriber, as described in [Event Fan-out](#event-fan-out).

If a subscriber fails, `publish()` rejects and the remaining events are not delivered. Outside any execution scope, events are delivered unchanged.

This package re-exports `EventPublisher`, `EventSubscriber`, and `SubscribableEventPublisher` from `@hexaijs/core`.

### Interceptors

An interceptor wraps every call of one kind, like middleware. It receives an interception context and a `next` function, and returns a `Result`.

```typescript
import {
    ApplicationBuilder,
    ApplicationError,
    ErrorResult,
    ExecutionScope,
    type CommandInterceptor,
} from "@hexaijs/application";

const requireSignedInUser: CommandInterceptor = async (ctx, next) => {
    if (ExecutionScope.getSecurityContext() === undefined) {
        return new ErrorResult(
            new ApplicationError({
                code: "UNAUTHENTICATED",
                message: `${ctx.message.getMessageType()} requires a signed-in user`,
            })
        );
    }
    return next();
};

const app = new ApplicationBuilder()
    .withApplicationContext(context)
    .withCommandHandler(CreateOrderCommand, () => new CreateOrderHandler())
    .withCommandInterceptor(requireSignedInUser)
    .build();
```

| Type | Registered with | Wraps |
|------|-----------------|-------|
| `CommandInterceptor` | `withCommandInterceptor()` | `executeCommand` |
| `QueryInterceptor` | `withQueryInterceptor()` | `executeQuery` |
| `EventInterceptor` | `withEventInterceptor()` | `handleEvent` |
| `Interceptor` | `withInterceptor()` | All three |

The interception context has `intent` (`"command"`, `"query"`, or `"event"`), `message`, and `metadata`, an object the interceptors of one call share.

- **Order.** Interceptors registered with `withInterceptor()` run first, as the outer layers, then the kind-specific ones. Within each group, the first registered is the outermost.
- **`next()`.** Call it at most once; a second call throws. Return a `Result` without calling it to stop the call, as `requireSignedInUser` does.
- **Errors.** An interceptor that throws makes the call reject. The application does not turn it into an `ErrorResult`.
- **Execution scope.** Interceptors run outside the execution scope the application opens for the message. Inside them, `ExecutionScope` shows the caller's scope: the security context is there, but the causation is not the message.

`InterceptedApplication.wrap(app)` adds interceptors to any `Application`, for example a `SimpleCompositeApplication`:

```typescript
import { InterceptedApplication } from "@hexaijs/application";

const intercepted = InterceptedApplication.wrap(compositeApp)
    .withInterceptor(loggingInterceptor)
    .build();
```

### Logging and Tracing

`createLoggingInterceptor()` returns an `Interceptor` that logs the start and end of every call:

```typescript
import { ApplicationBuilder, createLoggingInterceptor } from "@hexaijs/application";
import { createLogger } from "@hexaijs/application/pino";

const logger = createLogger({ level: "info", pretty: true });

const app = new ApplicationBuilder()
    .withApplicationContext(context)
    .withCommandHandler(CreateOrderCommand, () => new CreateOrderHandler())
    .withInterceptor(
        createLoggingInterceptor({
            logger,
            slowThresholdMs: 500,
            excludeTypes: [GetOrderQuery.getType()],
        })
    )
    .build();
```

| Option | Meaning |
|--------|---------|
| `logger` | Required. Any `Logger`: an object with pino-style `debug`, `info`, `warn`, `error`, `fatal` (each takes `msg` or `context, msg`) and `child(bindings)`. A pino logger fits. |
| `slowThresholdMs` | Logs a warning when a call takes longer. |
| `excludeTypes` | Message types not to log. |
| `includeTracing` | Default `true`. Adds `correlationId`, `correlationType`, `causationId`, and `causationType` from the message headers. |

Each entry carries `messageId` and `messageType`, plus `requestId`, `traceId`, `spanId`, `userId`, and `tenantId` when an earlier interceptor stored them as strings in `ctx.metadata`. Calls that resolve to an `ErrorResult` are logged as failures, and calls that reject are logged as exceptions. Queries are logged with the command messages, such as "Command execution started".

`@hexaijs/application/pino` needs the optional `pino` peer dependency:

| Export | What it does |
|--------|--------------|
| `createLogger(config)` | Creates a pino logger. `config`: `level`, `pretty` (uses `pino-pretty`), `redactPaths`, `base`. |
| `createTestLogger(config?)` | Creates a logger that keeps entries in memory, with `getLogs()`, `findLog()`, `findLogs()`, and `clear()`. |

`createTraceInterceptor()`, `traceCommandInterceptor`, and `traceEventInterceptor` store two traces in `ctx.metadata` for later interceptors: the current message, and the correlation (the message itself when it has none). Read them with `getCurrentMessageTrace(ctx.metadata)` and `getCorrelationTrace(ctx.metadata)`.

The `LoggingInterceptor`, `TraceCommandInterceptor`, and `TraceEventInterceptor` classes remain for backward compatibility; use the functions above.

### SelectorBasedEventHandler

`SelectorBasedEventHandler` routes events to methods with the `@When` decorator, so one class can handle several event types:

```typescript
import type { Message } from "@hexaijs/core";
import {
    SelectorBasedEventHandler,
    When,
    eventTypeMatches,
} from "@hexaijs/application";

class OrderNotifications extends SelectorBasedEventHandler<Message, OrderContext> {
    @When(eventTypeMatches(OrderPlaced.getType()))
    async onOrderPlaced(event: OrderPlaced, ctx: OrderContext): Promise<void> {
        await ctx.getEmailService().sendOrderConfirmation(event.getPayload().orderId);
    }

    @When(eventTypeMatches(/^order\.order-cancel/))
    async onOrderCancelled(event: Message, ctx: OrderContext): Promise<void> {
        // ...
    }
}
```

`eventTypeMatches()` takes a type string, an array of types, or a `RegExp`. `@When()` also accepts any `(event: Message) => boolean`.

- `canHandle()` returns `true` when any method's predicate matches.
- Exactly one method may match an event. When two match, `handle()` throws.
- `@When` is a legacy TypeScript decorator, so set `"experimentalDecorators": true` in your `tsconfig.json`.

### SimpleCompositeApplication

`SimpleCompositeApplication` combines the applications of several bounded contexts behind one `Application`:

```typescript
import { SimpleCompositeApplication } from "@hexaijs/application";

const compositeApp = new SimpleCompositeApplication(
    {
        "order.": orderApplication,
        "inventory.": inventoryApplication,
        "shipping.": shippingApplication,
    },
    unitOfWork
);

await compositeApp.executeCommand(new CreateOrderCommand({ customerId: "c-123", items: [] }));
// handled by orderApplication, because "order.create-order" starts with "order."

await compositeApp.handleEvent(orderPlaced);
// handled by every application, in one unit-of-work scope
```

**Commands and queries** go to the first application whose key is a prefix of the message type, checking keys in the object's order. With no match, the call resolves to an `ErrorResult` holding a `HandlerNotFound` error.

**Events** go to every application, not by prefix. `handleEvent()` runs them inside one `unitOfWork.scope()`, so their writes commit or roll back together. Pass the unit of work to the constructor or to `setUnitOfWork()`; without one, `handleEvent()` throws. It needs only the base `UnitOfWork.scope()`, not client access or lifecycle hooks.

When an application fails, `handleEvent()` rolls back the scope and resolves to an `ErrorResult`:

- an `ErrorResult` returned by an application is passed through;
- an `ApplicationError` thrown by an application is wrapped in an `ErrorResult`;
- any other thrown value becomes an `ApplicationError` that keeps the value in its `cause` chain.

Failures of the unit of work itself, such as a failed `COMMIT`, reject instead.

Inside an outer scope, a failed `handleEvent()` rolls back the outer transaction as well. The Postgres unit of work then rejects the outer scope with `TransactionAbortedError`. The SQLite unit of work rolls back without rejecting, so check the returned result.

### Event Fan-out

Three calls deliver one event to several handlers:

- `handleEvent()` of an application built by `ApplicationBuilder`, to its event handlers;
- `SimpleCompositeApplication.handleEvent()`, to its applications;
- `ApplicationEventPublisher.publish()`, to its subscribers.

All three start the handlers concurrently and settle only after every started handler has settled. They then report the first failure observed. Waiting for all of them keeps a surrounding `scope()` open until no handler can still use its transaction. A handler that throws synchronously, before returning a promise, stops the handlers after it from starting.

## API Reference

The main exports:

| Export | Description |
|--------|-------------|
| `ApplicationBuilder` | Fluent builder that assembles an `Application` |
| `Application` | `executeCommand`, `executeQuery`, `handleEvent` |
| `CommandDispatcher`, `QueryDispatcher`, `EventDispatcher` | The three halves of `Application`, one method each |
| `Command<P, R>`, `Query<P, R>` | Base classes for commands and queries, re-exported from `@hexaijs/contracts` |
| `CommandHandler<C, Ctx>`, `QueryHandler<Q, Ctx>` | Handler interfaces. The output type comes from the message. |
| `EventHandler<E, Ctx>` | Event handler interface: `canHandle`, `handle` |
| `SelectorBasedEventHandler`, `When`, `eventTypeMatches` | Decorator-based event routing |
| `ApplicationContext` | Empty interface for application contexts |
| `Result<R, E>`, `SuccessResult`, `ErrorResult` | Call outcomes |
| `ApplicationError`, `HandlerNotFound` | Errors in an `ErrorResult` |
| `ApplicationErrorTransformer`, `ApplicationErrorFactory` | Error transformer type; factory for `HandlerNotFound` |
| `ExecutionScope`, `ExecutionScopeSnapshot` | Per-call security context, correlation, and causation |
| `ApplicationEventPublisher` | `SubscribableEventPublisher<Message>` that sets causation, correlation, and security context |
| `EventPublisher`, `EventSubscriber`, `SubscribableEventPublisher` | Re-exported from `@hexaijs/core` |
| `CommandInterceptor`, `QueryInterceptor`, `EventInterceptor`, `Interceptor` | Interceptor function types |
| `CommandInterceptionContext`, `QueryInterceptionContext`, `EventInterceptionContext`, `InterceptionContext` | What an interceptor receives |
| `InterceptedApplication` | Adds interceptors to any `Application` (`InterceptedApplication.wrap(app)`) |
| `SimpleCompositeApplication` | Combines applications by message type prefix |
| `createLoggingInterceptor`, `LoggingInterceptorConfig`, `Logger`, `LogContext`, `LogLevel` | Logging |
| `createTraceInterceptor`, `traceCommandInterceptor`, `traceEventInterceptor`, `getCurrentMessageTrace`, `getCorrelationTrace` | Trace propagation through `ctx.metadata` |
| `createLogger`, `createTestLogger` (from `@hexaijs/application/pino`) | pino loggers |

## Migration Guide

### From v0.5.x to v0.6.x

- Upgrade `@hexaijs/core` to 0.11 or later: 0.6.0 dropped support for core 0.9 and 0.10.
- Since 0.6.2, `SimpleCompositeApplication.handleEvent()` rolls back when any application fails. It used to commit the writes of the applications that succeeded. It also returns a proper `ErrorResult` when an application throws, instead of the raw thrown value. Review callers that relied on the old behavior.
- Since 0.6.2, `handleEvent()` and `ApplicationEventPublisher.publish()` wait for every handler to settle before reporting the first failure.

### From v0.4.0 to v0.5.0

This version replaces the message-level security context with `ExecutionScope` and simplifies the application context.

#### Command and Query

**Before (v0.4.x)**:
```typescript
class MyCommand extends Command<Payload, ResultType, MySecurityContext> {}
const sc = command.getSecurityContext(); // from the message
```

**After (v0.5.0)**:
```typescript
class MyCommand extends Command<Payload, ResultType> {}
const sc = ExecutionScope.requireSecurityContext<MySecurityContext>(); // from the execution scope
```

#### Security Context in Handlers

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

To attach a security context, replace `command.withSecurityContext(sc)` with `ExecutionScope.run({ securityContext: sc }, fn)` around the call.

#### ApplicationContext

The `ApplicationContext` interface replaces the `AbstractApplicationContext` class. Define contexts as plain interfaces instead of extending an abstract class.

#### Logging

`createLogger`, `createTestLogger`, `TestLogger`, and `TestLogEntry` moved to the `@hexaijs/application/pino` subpath, and `pino` became an optional peer dependency.

#### Quick Migration Checklist

- [ ] Replace `Command<P, O, SC>` with `Command<P, O>`
- [ ] Replace `Query<P, O, SC>` with `Query<P, O>`
- [ ] Replace `command.getSecurityContext()` / `command.withSecurityContext()` with `ExecutionScope` methods
- [ ] Remove `MessageWithAuth` and `MessageWithAuthOptions` imports
- [ ] Remove `clone()`, `deriveFrom()`, `onEnter()`, `onExit()`, `enterCommandExecutionScope()` overrides from application context classes
- [ ] Import `createLogger` and `createTestLogger` from `@hexaijs/application/pino`, and install `pino` if you use them
- [ ] Add `@hexaijs/contracts` `^0.1.0` as a peer dependency

### From v0.3.1 to v0.4.0

This version moves correlation and causation tracing into the `Message` API of `@hexaijs/core`.

#### Correlation and Causation Headers

**Before (v0.3.x)**, with raw headers:
```typescript
const cmd = new MyCommand(payload)
    .withHeader("correlationId", "corr-123")
    .withHeader("correlationType", "HttpRequest");
```

**After (v0.4.0)**, with typed methods:
```typescript
const cmd = new MyCommand(payload)
    .withCorrelation({ id: "corr-123", type: "HttpRequest" });

cmd.getCorrelation();  // { id: "corr-123", type: "HttpRequest" }
```

The `messaging-support` functions (`causationOf`, `correlationOf`, `setCausationOf`, `setCorrelationOf`, `asTrace`) and its `MessageTrace` type were removed. Use the `Message` methods, and import `MessageTrace` from `@hexaijs/core`.

#### Quick Migration Checklist

- [ ] Replace `import { MessageTrace } from "@hexaijs/application"` with `import { MessageTrace } from "@hexaijs/core"`
- [ ] Replace `import { asTrace, causationOf, ... } from "@hexaijs/application"` with `Message` methods
- [ ] Replace `withHeader("correlationId", ...)` / `withHeader("correlationType", ...)` with `withCorrelation({ id, type })`
- [ ] Replace `withHeader("causationId", ...)` / `withHeader("causationType", ...)` with `withCausation({ id, type })`
- [ ] Replace `getHeader("correlationId")` with `getCorrelation()?.id`
- [ ] Replace `causationOf(msg)` with `msg.getCausation()`
- [ ] Replace `correlationOf(msg)` with `msg.getCorrelation()`
- [ ] Replace `asTrace(msg)` with `msg.asTrace()`
- [ ] Update the `@hexaijs/core` peer dependency to `^0.6.0`

### From v0.2.x to v0.3.1

`MessageWithAuth` and its constructor options were removed in v0.5.0; see [From v0.4.0 to v0.5.0](#from-v040-to-v050). Version 0.3.0 made the package ESM-only.

Version 0.3.1 changed the constructors of `Command`, `Query`, and `MessageWithAuth` from positional parameters to an options object.

#### Constructor Pattern

**Before (v0.2.x)**:
```typescript
const command = new CreateOrderCommand(payload, headers, securityContext);
```

**After (v0.3.1)**:
```typescript
const command = new CreateOrderCommand(payload, {
    headers,
    securityContext,
});
```

#### Clone Methods

`MessageWithAuth` no longer overrides `clone()`, `cloneWithHeaders()`, and `withHeader()`; it inherits them from `Message` in `@hexaijs/core`. The public API (`withHeader()`, `withSecurityContext()`) stays the same.

#### Quick Migration Checklist

- [ ] Update `new Command(payload, headers, sc)` to `new Command(payload, { headers, securityContext: sc })`
- [ ] Update `new Query(payload, headers, sc)` to `new Query(payload, { headers, securityContext: sc })`
- [ ] Remove direct calls to `clone()` or `cloneWithHeaders()` on `MessageWithAuth` (use `withHeader()` / `withSecurityContext()` instead)

### From v0.1.x to v0.2.0

The security context type parameter described here was removed in v0.5.0; `Command` is now `Command<P, O>`. See [From v0.4.0 to v0.5.0](#from-v040-to-v050).

This version added output type inference, which changed the type parameters.

#### Command and Query

**Before (v0.1.x)**:
```typescript
// The second type parameter was the security context
class MyCommand extends Command<Payload, MySecurityContext> {}
```

**After (v0.2.0)**:
```typescript
// The second type parameter is the result type; the security context moved to third
class MyCommand extends Command<Payload, ResultType, MySecurityContext> {}

// Without a custom security context, use two parameters:
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
// The output type is inferred from MyCommand's ResultType
class MyHandler implements CommandHandler<MyCommand, Context> {
    async execute(cmd: MyCommand, ctx: Context): Promise<OutputType> { ... }
}
```

#### Quick Migration Checklist

- [ ] Update `Command<P, SC>` to `Command<P, O, SC>` or `Command<P, O>`
- [ ] Update `Query<P, SC>` to `Query<P, O, SC>` or `Query<P, O>`
- [ ] Remove the `O` parameter from `CommandHandler<I, O, Ctx>`, making it `CommandHandler<I, Ctx>`
- [ ] Remove the `O` parameter from `QueryHandler<I, O, Ctx>`, making it `QueryHandler<I, Ctx>`

## See Also

- [@hexaijs/core](../core/README.md): messages, domain building blocks, and the unit of work and event publisher contracts
- [@hexaijs/contracts](../contracts/README.md): where `Command` and `Query` are defined
- [@hexaijs/postgres](../postgres/README.md): PostgreSQL unit of work, event store, and event store sink
- [@hexaijs/sqlite](../sqlite/README.md): SQLite unit of work, mainly for tests
- [@hexaijs/plugin-application-builder](../plugin-application-builder/README.md): generates `ApplicationBuilder` registration code from decorated handlers
