# @hexaijs/core

> Messages, domain building blocks, and the transaction and event contracts that every hexai package shares

## Overview

`@hexaijs/core` holds the types the other hexai packages build on. It has three parts:

- **Messages.** `Message` is the base class for commands, queries, and events. Each message carries a typed payload and headers such as an id, a type, and a creation time.
- **Domain building blocks.** `AggregateRoot`, `DomainEvent`, `Id`, `Repository`, and a small set of domain errors.
- **Infrastructure contracts.** `UnitOfWork`, `TransactionLifecycle`, `EventPublisher`, and `EventStore` describe what a database or messaging adapter provides. This package contains no database code.

Use it in your domain layer. Add [`@hexaijs/application`](../application/README.md) to route commands, queries, and events to handlers, and [`@hexaijs/postgres`](../postgres/README.md) or [`@hexaijs/sqlite`](../sqlite/README.md) for a unit of work.

## Installation

```bash
npm install @hexaijs/core
```

The package is ESM-only. Its one peer dependency, `vitest`, is optional: install it only when you import the [test helpers](#test-helpers) from `@hexaijs/core/test`. The supported version range is in this package's `package.json`.

## Quick Start

An aggregate records what happened as domain events. You collect the events after the change and hand them to whatever publishes them.

```typescript
import {
    AggregateRoot,
    DomainEvent,
    Id,
    InvariantNotSatisfiedError,
} from "@hexaijs/core";

class OrderId extends Id<string> {}

class OrderPlaced extends DomainEvent<{ orderId: string; customerId: string }> {
    static readonly type = "order.order-placed";
}

class OrderConfirmed extends DomainEvent<{ orderId: string }> {
    static readonly type = "order.order-confirmed";
}

class Order extends AggregateRoot<OrderId> {
    private status: "pending" | "confirmed" = "pending";

    static place(id: OrderId, customerId: string): Order {
        const order = new Order(id);
        order.raise(new OrderPlaced({ orderId: id.getValue(), customerId }));
        return order;
    }

    confirm(): void {
        if (this.status !== "pending") {
            throw new InvariantNotSatisfiedError(
                "ORDER_NOT_PENDING",
                "Only pending orders can be confirmed"
            );
        }
        this.status = "confirmed";
        this.raise(new OrderConfirmed({ orderId: this.getId().getValue() }));
    }
}

const order = Order.place(new OrderId("order-1"), "customer-1");
order.confirm();

const events = order.flushEvents();
events.map((event) => event.getMessageType());
// ["order.order-placed", "order.order-confirmed"]
```

The later examples in this README reuse `Order`, `OrderId`, and `OrderPlaced`.

## Messages

A message is an immutable object with a typed payload and a set of headers. Commands, queries, and events are all messages. In an application you usually extend `Command` or `Query` from [`@hexaijs/application`](../application/README.md), or `DomainEvent` from this package, rather than `Message` itself.

### Defining a Message

Give each message class a static `type`. The convention is `"<bounded-context>.<message-name>"`.

```typescript
import { Message } from "@hexaijs/core";

class CreateOrder extends Message<{
    customerId: string;
    items: { productId: string; quantity: number }[];
}> {
    static readonly type = "order.create-order";
}

const message = new CreateOrder({
    customerId: "customer-123",
    items: [{ productId: "product-456", quantity: 2 }],
});

message.getMessageId();   // a random UUID
message.getMessageType(); // "order.create-order"
message.getTimestamp();   // the Date the message was created
message.getPayload();     // the typed payload
```

Without a static `type`, the type falls back to the class name. Set it explicitly: a class name changes when you rename the class or minify the code, and [`@hexaijs/application`](../application/README.md) finds handlers by type.

### Headers

The constructor generates these headers:

| Header | Value | Read with |
|--------|-------|-----------|
| `id` | A random UUID | `getMessageId()` |
| `type` | The class's static `type` | `getMessageType()` |
| `createdAt` | The current `Date` | `getTimestamp()` |
| `intent` | The class's static `intent`, if any. `DomainEvent` sets `"event"`; `Command` and `Query` set `"command"` and `"query"` | `getHeader("intent")` |
| `schemaVersion` | The class's static `schemaVersion`, if any | `getSchemaVersion()` |

`getHeader(name)` reads any header, and `getHeaders()` returns a frozen copy of all of them.

Pass extra headers through the second constructor argument, `MessageOptions`. A header you pass replaces the generated header of the same name.

```typescript
const correlated = new CreateOrder(
    { customerId: "customer-123", items: [] },
    { headers: { correlation: { id: "request-abc", type: "HttpRequest" } } }
);
```

`withHeader(name, value)` returns a copy of the message with one more header. The original does not change.

```typescript
const tagged = message.withHeader("source", "api-gateway");
```

### Immutability

Headers are frozen. The constructor shallow-copies an object payload and freezes the copy, so the message's top-level payload fields cannot change and the object you passed in stays mutable. Nested objects are shared with your object, not copied or frozen.

### Correlation and Causation

Two headers trace how messages lead to one another:

- **Correlation** points to the message that started the whole flow, such as the HTTP request that triggered a command.
- **Causation** points to the message that directly caused this one, such as the command whose handler raised an event.

Both hold a `MessageTrace`, which is `{ id, type }`.

```typescript
import type { MessageTrace } from "@hexaijs/core";

const command = new CreateOrder({ customerId: "customer-123", items: [] })
    .withCorrelation({ id: "request-abc", type: "HttpRequest" });

const trace: MessageTrace = command.asTrace();
// { id: "<command id>", type: "order.create-order" }

const event = new OrderPlaced({ orderId: "order-1", customerId: "customer-123" })
    .withCausation(command.asTrace())
    .withCorrelation(command.getCorrelation() ?? command.asTrace());

event.getCausation();   // { id: "<command id>", type: "order.create-order" }
event.getCorrelation(); // { id: "request-abc", type: "HttpRequest" }
```

You rarely set these by hand. `ApplicationEventPublisher` in `@hexaijs/application` sets both on the events it publishes from inside a handler; see [Wiring the Unit of Work and Event Publishing](../application/README.md#wiring-the-unit-of-work-and-event-publishing).

### Serialization

| Method | Returns |
|--------|---------|
| `toJSON()` | `{ headers, payload }`. `createdAt` stays a `Date`. `JSON.stringify(message)` uses it. |
| `serialize()` | The same shape as a plain JSON value: the result of `JSON.parse(JSON.stringify(message.toJSON()))`, so `createdAt` becomes an ISO string. |
| `Class.from(payload, headers?)` | A message rebuilt from serialized data. `createdAt` turns back into a `Date`. Without `headers`, it generates new ones. |

Override `serializePayload()` and `deserializeRawPayload()` when the payload holds values JSON cannot represent. For example, `JSON.stringify()` throws on a `bigint`:

```typescript
import { DomainEvent } from "@hexaijs/core";

type PaymentPayload = { paymentId: string; amountInCents: bigint };

class PaymentReceived extends DomainEvent<PaymentPayload> {
    static readonly type = "billing.payment-received";

    protected override serializePayload(payload: PaymentPayload) {
        return { ...payload, amountInCents: payload.amountInCents.toString() };
    }

    protected static override deserializeRawPayload(raw: {
        paymentId: string;
        amountInCents: string;
    }): PaymentPayload {
        return { ...raw, amountInCents: BigInt(raw.amountInCents) };
    }
}

const { headers, payload } = new PaymentReceived({
    paymentId: "payment-1",
    amountInCents: 1999n,
}).serialize();
// payload.amountInCents is "1999", headers.createdAt is an ISO string

const restored = PaymentReceived.from(payload, headers) as PaymentReceived;
restored.getPayload().amountInCents; // 1999n
```

`from()` is typed to return `Message`, so cast the result to the class you called it on. `message.asType(OtherClass)` rebuilds a message as an instance of another class, through `serialize()` and `OtherClass.from()`.

## Domain Building Blocks

### DomainEvent

`DomainEvent<P>` is a message that records something that happened in the domain. Its payload is an object, and its `intent` header is `"event"`. Compare types to recognize an event:

```typescript
import type { Message } from "@hexaijs/core";

function isOrderPlaced(message: Message): boolean {
    return message.getMessageType() === OrderPlaced.getType();
}
```

### Id and Identifiable

`Id<T>` is a value object for an identity whose value is a `string` or a `number`. Subclass it once per entity so that IDs of different entities do not mix.

```typescript
import { Id } from "@hexaijs/core";

class CustomerId extends Id<string> {}

const orderId = new OrderId("order-123");
orderId.getValue();                          // "order-123"
orderId.equals(new OrderId("order-123"));    // true
orderId.equals(new CustomerId("order-123")); // false: different ID classes
```

`equals()` is true only for the same class and the same value. TypeScript accepts the last call, because both classes have the same shape; the class check happens at runtime.

`Identifiable<T>` is the interface `{ getId(): T }`. `IdOf<E>` extracts the ID type of an identifiable type `E`.

### AggregateRoot

`AggregateRoot<T>` is the base class for an aggregate, the cluster of objects that changes together, identified by an `Id`. It implements `Identifiable<T>`.

| Member | What it does |
|--------|--------------|
| `getId()` | Returns the aggregate's ID. |
| `raise(event)` | Protected. Records a `DomainEvent`. Nothing is published yet. |
| `getEventsOccurred()` | Returns a copy of the recorded events. |
| `flushEvents()` | Returns the recorded events and clears the list, so the same events are not published twice. |

The usual flow is: change the aggregate, save it, then publish `flushEvents()`. [`@hexaijs/application`](../application/README.md#wiring-the-unit-of-work-and-event-publishing) shows that flow inside a handler.

### Repository

`Repository<T>` is the persistence interface for an aggregate: `get(id)`, `add(entity)`, and `update(entity)`. You implement it in your infrastructure code. Throw `ObjectNotFoundError` and `DuplicateObjectError` so callers can handle a missing or duplicate aggregate without knowing the database.

```typescript
import {
    DuplicateObjectError,
    ObjectNotFoundError,
    type Repository,
} from "@hexaijs/core";

class InMemoryOrderRepository implements Repository<Order> {
    private readonly orders = new Map<string, Order>();

    async get(id: OrderId): Promise<Order> {
        const order = this.orders.get(id.getValue());
        if (!order) {
            throw new ObjectNotFoundError(`Order ${id.getValue()} not found`);
        }
        return order;
    }

    async add(order: Order): Promise<void> {
        const id = order.getId().getValue();
        if (this.orders.has(id)) {
            throw new DuplicateObjectError(`Order ${id} already exists`);
        }
        this.orders.set(id, order);
    }

    async update(order: Order): Promise<void> {
        this.orders.set(order.getId().getValue(), order);
    }
}
```

### Domain Errors

| Error | Extends | Constructor | Use it for |
|-------|---------|-------------|------------|
| `DomainError` | `Error` | `(message?)` | Base class for domain errors |
| `InvariantNotSatisfiedError` | `DomainError` | `(code, message = "")` | A broken business rule. Exposes `code`. |
| `ValidationError` | `InvariantNotSatisfiedError` | `(field, code, message = "")` | An invalid field. Exposes `field` and `code`. |
| `RepositoryError` | `Error` | `(message)` | Base class for persistence errors |
| `ObjectNotFoundError` | `RepositoryError` | `(message)` | No aggregate with the requested ID |
| `DuplicateObjectError` | `RepositoryError` | `(message)` | An aggregate with that ID already exists |

```typescript
import { ValidationError } from "@hexaijs/core";

throw new ValidationError("email", "INVALID_FORMAT", "Email must be a valid address");
```

## Unit of Work and Transactions

A unit of work groups the writes of one business operation into one transaction, so they all commit or all roll back. Core defines the contracts; [`@hexaijs/postgres`](../postgres/README.md) and [`@hexaijs/sqlite`](../sqlite/README.md) implement them.

The contracts are split by capability, so code depends only on what it uses:

| Interface | Adds | Depend on it when |
|-----------|------|-------------------|
| `UnitOfWork` | `scope()` | You need a transaction boundary. This covers most code. |
| `TransactionLifecycle` | `beforeCommit()`, `afterCommit()`, `afterRollback()` | You need to run code at commit or rollback. |
| `UnitOfWorkClientAccess` | `getClient()` and the deprecated `wrap()` | Code needs the transaction's raw client. See [Client Access](#client-access). |

### scope()

`scope(fn)` runs `fn` inside a transaction. When the scope that started the transaction finishes, the transaction commits if `fn` resolved and rolls back if `fn` rejected. `scope()` then resolves with `fn`'s result or rejects with its error.

```typescript
import { randomUUID } from "node:crypto";
import type { Repository, UnitOfWork } from "@hexaijs/core";

async function placeOrder(
    unitOfWork: UnitOfWork,
    orders: Repository<Order>,
    customerId: string
): Promise<string> {
    return unitOfWork.scope(async () => {
        const order = Order.place(new OrderId(randomUUID()), customerId);
        await orders.add(order);
        return order.getId().getValue();
    });
}
```

`fn` receives no database client. Repositories reach the current transaction through the implementation; in `@hexaijs/postgres`, a repository takes `unitOfWork.db`. Each implementation also decides when the transaction actually starts. See its README for details.

In an application, the unit of work usually lives in the application context; see [Wiring the Unit of Work and Event Publishing](../application/README.md#wiring-the-unit-of-work-and-event-publishing).

### Propagation

Pass `{ propagation }` to say how a scope relates to a transaction that is already running:

```typescript
import { Propagation } from "@hexaijs/core";

await unitOfWork.scope(async () => {
    await unitOfWork.scope(async () => {
        // Runs in its own transaction: it commits even if the outer one rolls back.
    }, { propagation: Propagation.NEW });
});
```

| Value | Meaning |
|-------|---------|
| `Propagation.EXISTING` | Join the current transaction, or start one if there is none. |
| `Propagation.NEW` | Always start a separate transaction. |
| `Propagation.NESTED` | Run in a savepoint inside the current transaction, so a failure rolls back only this part. |

Each implementation decides which modes it supports and which one is the default. `@hexaijs/postgres` supports all three and defaults to `EXISTING`.

### Transaction Lifecycle Hooks

`TransactionLifecycle` lets code inside a scope register callbacks for the current transaction:

```typescript
import type { Repository, TransactionLifecycle, UnitOfWork } from "@hexaijs/core";

async function confirmOrder(
    unitOfWork: UnitOfWork & TransactionLifecycle,
    orders: Repository<Order>,
    orderId: OrderId
): Promise<void> {
    await unitOfWork.scope(async () => {
        const order = await orders.get(orderId);
        order.confirm();
        await orders.update(order);

        // Runs before COMMIT. If it throws, the transaction rolls back.
        unitOfWork.beforeCommit(async () => {
            await checkCreditLimit(orderId);
        });

        // Runs after every ordinary beforeCommit hook, still before COMMIT.
        unitOfWork.beforeCommit(async () => {
            await flushOutbox();
        }, { phase: "drain" });

        // Runs after COMMIT.
        unitOfWork.afterCommit(async () => {
            await notifyWarehouse(orderId);
        });

        // Runs after ROLLBACK.
        unitOfWork.afterRollback(async () => {
            await releaseReservation(orderId);
        });
    });
}
```

Register hooks inside `scope()`. They belong to the current transaction and are dropped when it ends. The hexai implementations throw when you register a hook outside a scope.

| Hook | When it runs | If it fails |
|------|--------------|-------------|
| `beforeCommit(hook)` | Before `COMMIT`, one hook at a time, in registration order | The transaction rolls back, `afterRollback` hooks run, and the scope rejects with the hook's error. |
| `beforeCommit(hook, { phase: "drain" })` | After every ordinary `beforeCommit` hook, still before `COMMIT` | Same as above. |
| `afterCommit(hook)` | After `COMMIT`, one at a time | Every hook still runs. The commit stands, and the scope rejects with an `AggregateError` of the hook errors. |
| `afterRollback(hook)` | After `ROLLBACK`, one at a time | Every hook still runs. The scope rejects with an `AggregateError` whose `cause` is the error that caused the rollback. |

If `COMMIT` itself fails, no after hook runs.

Use the default phase for checks that guard the commit. Use the `"drain"` phase for work that must run after those checks but inside the same transaction, such as flushing a transaction-local buffer. An ordinary `beforeCommit` hook may register drain hooks. Registering a hook in a phase that has already started throws `BeforeCommitPhaseClosedError`.

Observers that fire on every commit of a unit of work, such as `onEveryCommit()` in `@hexaijs/postgres`, are not part of this contract. They belong to the implementation.

### TransactionHooks

`TransactionHooks` is the hook registry that applies the rules in the table above. `@hexaijs/postgres` and `@hexaijs/sqlite` use it, and you can use it when you write your own unit of work. Create one per transaction.

| Method | What it does |
|--------|--------------|
| `addBeforeCommit(hook, phase = "main")` | Registers a `beforeCommit` hook in the `"main"` or `"drain"` phase. |
| `addAfterCommit(hook)` | Registers an `afterCommit` hook. |
| `addAfterRollback(hook)` | Registers an `afterRollback` hook. |
| `executeCommit(commit, rollback)` | Runs the `beforeCommit` hooks, then `commit`, then the `afterCommit` hooks. If a `beforeCommit` hook fails, it calls `rollback`, runs the `afterRollback` hooks, and rethrows. |
| `executeRollback(rollback, cause?)` | Calls `rollback`, then runs the `afterRollback` hooks. |

### Client Access

`UnitOfWorkClientAccess<Client>` extends `UnitOfWork` with `getClient()`, which returns the client of the current transaction, and `wrap(fn)`, which is deprecated in favor of `scope()`. Depend on it only in code that needs the raw client; everything else should depend on `UnitOfWork`.

How you reach the client depends on the implementation. The SQLite unit of work returns its `Database` from `getClient()`; see the [sqlite README](../sqlite/README.md). The Postgres unit of work no longer fits this interface: `@hexaijs/postgres` 0.16.0 removed `wrap()` and deprecated `getClient()` in favor of `unitOfWork.db`; see the [postgres README](../postgres/README.md).

## Event Publishing Contracts

Core defines how events flow, not where they go:

```typescript
interface EventPublisher<E extends object = any> {
    publish(...events: E[]): Promise<void>;
}

type EventSubscriber<E extends object = any> = (event: E) => void | Promise<void>;

interface SubscribableEventPublisher<E extends object = any> extends EventPublisher<E> {
    subscribe(subscriber: EventSubscriber<E>): () => void; // returns an unsubscribe function
}
```

`ApplicationEventPublisher` in [`@hexaijs/application`](../application/README.md) implements `SubscribableEventPublisher<Message>`. Infrastructure packages subscribe to any such publisher; for example, `attachPostgresEventStoreSink()` in [`@hexaijs/postgres`](../postgres/README.md) stores published events in the current transaction. Buffers, sinks, and other storage-aware adapters live in those packages, not in core.

## EventStore

`EventStore` is the read side of an event store. Each stored event has a `position`, a number that increases in the order events were stored.

```typescript
interface StoredEvent {
    position: number;
    event: Message;
}

interface EventStoreFetchResult {
    events: StoredEvent[];
    lastPosition: number;
}

interface EventStore {
    fetch(afterPosition: number, limit?: number): Promise<EventStoreFetchResult>;
    stream?(afterPosition: number, batchSize: number): AsyncGenerator<StoredEvent>;
    getEventCount?(afterPosition: number): Promise<number>;
}
```

| Method | What it does |
|--------|--------------|
| `fetch(afterPosition, limit?)` | Returns the events after `afterPosition`, oldest first. In the hexai implementations, `lastPosition` is the highest position in the whole store (0 when empty), not in the returned batch. |
| `stream(afterPosition, batchSize)` | Optional. Yields events one by one while fetching them in batches. |
| `getEventCount(afterPosition)` | Optional. Counts the events after `afterPosition`. |

Writing events is up to each implementation. `PostgresEventStore` in [`@hexaijs/postgres`](../postgres/README.md) implements this interface, and `InMemoryEventStore` in [`@hexaijs/core/test`](#test-helpers) is an in-memory version for tests.

## Test Helpers

`@hexaijs/core/test` provides assertions and fakes for vitest tests. It imports `vitest`, so install `vitest` to use it.

```typescript
import { expectMessageToMatch } from "@hexaijs/core/test";

const order = Order.place(new OrderId("order-1"), "customer-1");

expectMessageToMatch(order.flushEvents(), OrderPlaced, { customerId: "customer-1" });
```

| Export | What it does |
|--------|--------------|
| `expectMessageToMatch(messages, typeOrClass, payload?)` | Asserts that a message of that type has a payload containing `payload`. Nested objects match partially, and arrays match element by element at the same index. On failure, it lists the types found or the closest payload. |
| `expectMessagesToContain(messages, expected)` | Runs `expectMessageToMatch` for each expected message, using its type and payload. |
| `expectMessagesToBeFullyEqual(messages, expected)` | Asserts both lists hold the same messages in the same order, every header included (`id`, `createdAt`, ...). |
| `matchers` | The three assertions above, as one namespace. |
| `partialMatch(source, target)` | Returns `true` when `source` contains `target`, by the same rules as `expectMessageToMatch`. |
| `DummyMessage` | A ready-made message of type `"test.dummy-message"`, with `create()` and `createMany(count)`. |
| `InMemoryEventStore` | An in-memory `EventStore` with `store()`, `storeAll()`, `getLastPosition()`, and `clear()`. |
| `waitForTicks(count = 10)`, `waitForMs(ms = 10)`, `waitFor(kind, count)` | Waits for pending async work to run. |

## API Reference

| Export | Description |
|--------|-------------|
| `Message<P>` | Base class for messages: typed payload, headers, tracing, serialization |
| `MessageOptions` | Constructor options: `{ headers? }` |
| `MessageHeaders` | The header object: `id`, `type`, `createdAt`, optional `intent` and `schemaVersion`, and any custom headers |
| `MessageTrace` | `{ id, type }`, a message's identity in correlation and causation headers |
| `MessageClass<M>` | The static side of a message class: `getType()`, `from()`, a constructor |
| `AnyMessage`, `PayloadOf<M>` | Type helpers: any message; the payload type of a message type |
| `DomainEvent<P>` | Message for domain events (`intent: "event"`) |
| `AggregateRoot<T>` | Base class for aggregates that record domain events |
| `Id<T>`, `Identifiable<T>`, `IdOf<E>` | Typed identities |
| `Repository<T>` | Persistence interface: `get`, `add`, `update` |
| `DomainError`, `InvariantNotSatisfiedError`, `ValidationError` | Domain errors |
| `RepositoryError`, `ObjectNotFoundError`, `DuplicateObjectError` | Persistence errors |
| `UnitOfWork` | Transaction boundary: `scope(fn, options?)` |
| `BaseUnitOfWorkOptions`, `Propagation` | Scope options and propagation modes |
| `TransactionLifecycle` | `beforeCommit`, `afterCommit`, `afterRollback` |
| `TransactionHook`, `BeforeCommitOptions`, `BeforeCommitPhase` | Hook callback type `() => void \| Promise<void>`, and the `"main"` / `"drain"` phase option |
| `TransactionHooks`, `BeforeCommitPhaseClosedError` | Hook registry for unit-of-work implementations, and the error it throws for late registration |
| `UnitOfWorkClientAccess` | `getClient()` and the deprecated `wrap()` |
| `EventPublisher`, `EventSubscriber`, `SubscribableEventPublisher` | Event flow contracts |
| `EventStore`, `StoredEvent`, `EventStoreFetchResult` | Event store read contract |

## Migration Notes

### From 0.11.x to 0.12.0

The base `UnitOfWork` interface now has only `scope()`.

- Code that calls `getClient()` or `wrap()` depends on `UnitOfWorkClientAccess` instead.
- Code that registers `beforeCommit`, `afterCommit`, or `afterRollback` hooks depends on `TransactionLifecycle`, for example `UnitOfWork & TransactionLifecycle`.
- Code that only opens scopes keeps `UnitOfWork`.

## See Also

- [@hexaijs/application](../application/README.md): commands, queries, handlers, and event publishing on top of these messages
- [@hexaijs/postgres](../postgres/README.md): PostgreSQL unit of work and event store
- [@hexaijs/sqlite](../sqlite/README.md): SQLite unit of work, mainly for tests
