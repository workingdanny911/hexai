# @hexaijs/core

> Core domain primitives for building hexagonal architecture applications

## Overview

`@hexaijs/core` provides the foundational building blocks for domain-driven design in TypeScript applications. It establishes the core abstractions that all other @hexai packages build upon.

The package focuses on three key areas:

1. **Messaging** - A unified `Message` abstraction for commands, queries, and events with built-in headers (id, type, timestamp, schema version)
2. **Domain Modeling** - Base classes for aggregates, entities, and domain events following DDD tactical patterns
3. **Infrastructure Interfaces** - Abstract contracts for repositories, unit of work, and event stores that infrastructure packages implement

These primitives are intentionally minimal. They define contracts and patterns without prescribing implementation details, allowing you to integrate with any database, message broker, or framework.

## Installation

```bash
npm install @hexaijs/core
```

## Core Concepts

### Message

`Message` is the base abstraction for all messages in the system - commands, queries, and events share this foundation.

```typescript
import { Message } from "@hexaijs/core";

class CreateOrderCommand extends Message<{
    customerId: string;
    items: { productId: string; quantity: number }[];
}> {
    static readonly type = "order.create-order";
}

// Create a message
const command = new CreateOrderCommand({
    customerId: "customer-123",
    items: [{ productId: "product-456", quantity: 2 }]
});

// Access message data
command.getMessageId();      // unique UUID
command.getMessageType();    // "order.create-order"
command.getTimestamp();      // Date when created
command.getPayload();        // the typed payload object
```

Every message automatically receives headers including a unique ID and timestamp. The `type` static property follows the convention `"bounded-context.message-name"`.

#### MessageOptions

The constructor accepts an optional `MessageOptions` object for passing custom headers:

```typescript
interface MessageOptions {
    headers?: Record<string, unknown>;
}

// Pass custom headers
const command = new CreateOrderCommand(
    { customerId: "customer-123", items: [] },
    { headers: { correlationId: "corr-abc" } }
);
```

#### Serialization

Messages provide two serialization methods:

```typescript
// toJSON() - preserves Date objects, suitable for structured output
const json = command.toJSON();
// { headers: { id, type, createdAt: Date, ... }, payload: { ... } }

// serialize() - fully serialized plain object (dates become strings)
const plain = command.serialize();
// { headers: { id, type, createdAt: "2026-...", ... }, payload: { ... } }

// JSON.stringify uses toJSON() automatically
JSON.stringify(command);
```

Override `serializePayload()` to customize how the payload is serialized:

```typescript
class MyEvent extends DomainEvent<{ date: Temporal.PlainDate }> {
    protected serializePayload(payload: { date: Temporal.PlainDate }) {
        return { date: payload.date.toString() };
    }
}
```

#### Deserialization

Use the static `from()` method to reconstruct a message from serialized data:

```typescript
const raw = { customerId: "c-123", items: [] };
const headers = { id: "msg-1", type: "order.create-order", createdAt: "2026-01-01T00:00:00Z" };

const command = CreateOrderCommand.from(raw, headers);
```

Override `deserializeRawPayload()` for custom deserialization:

```typescript
class MyEvent extends DomainEvent<{ date: Temporal.PlainDate }> {
    protected static deserializeRawPayload(raw: any) {
        return { date: Temporal.PlainDate.from(raw.date) };
    }
}
```

#### Fluent Header API

Use `withHeader()` to create a new message instance with an additional header:

```typescript
const command = new CreateOrderCommand({ customerId: "c-123", items: [] })
    .withHeader("correlationId", "corr-abc")
    .withHeader("source", "api-gateway");

command.getHeader("correlationId"); // "corr-abc"
```

`withHeader()` returns a new immutable instance - the original message is not modified.

### DomainEvent

`DomainEvent` extends `Message` for events that represent something that happened in your domain.

```typescript
import { DomainEvent } from "@hexaijs/core";

export class OrderPlaced extends DomainEvent<{
    orderId: string;
    customerId: string;
    totalAmount: number;
}> {
    static readonly type = "order.order-placed";
}

// Create and use domain events
const event = new OrderPlaced({
    orderId: "order-789",
    customerId: "customer-123",
    totalAmount: 150.00
});

// Check event type
if (message.getMessageType() === OrderPlaced.getType()) {
    const payload = message.getPayload();
    // Handle the event...
}
```

### Id and Identifiable

Value objects for identity, ensuring type safety for entity IDs.

```typescript
import { Id, Identifiable } from "@hexaijs/core";

// Create a typed ID class
class OrderId extends Id<string> {}

// Use it in your domain
const orderId = new OrderId("order-123");
orderId.getValue();  // "order-123"

// Compare IDs
const sameId = new OrderId("order-123");
orderId.equals(sameId);  // true

// Different ID types are not comparable
class CustomerId extends Id<string> {}
const customerId = new CustomerId("order-123");
// orderId.equals(customerId) - TypeScript prevents this
```

### AggregateRoot

Base class for aggregate roots that collect domain events for later dispatch.

```typescript
import { AggregateRoot, Id } from "@hexaijs/core";

class OrderId extends Id<string> {}

class Order extends AggregateRoot<OrderId> {
    private status: "pending" | "confirmed" | "shipped" = "pending";

    static create(orderId: OrderId, customerId: string): Order {
        const order = new Order(orderId);
        order.raise(new OrderPlaced({
            orderId: orderId.getValue(),
            customerId,
            totalAmount: 0
        }));
        return order;
    }

    confirm(): void {
        if (this.status !== "pending") {
            throw new Error("Can only confirm pending orders");
        }
        this.status = "confirmed";
        this.raise(new OrderConfirmed({
            orderId: this.getId().getValue()
        }));
    }
}

// Usage
const order = Order.create(new OrderId("order-123"), "customer-456");
order.confirm();

// Events are collected, not immediately published
const events = order.getEventsOccurred();
// [OrderPlaced, OrderConfirmed]
```

### Repository

Interface for aggregate persistence. Implementations live in infrastructure packages.

```typescript
import { Repository, ObjectNotFoundError } from "@hexaijs/core";

// Define your repository interface
interface OrderRepository extends Repository<Order> {
    get(id: OrderId): Promise<Order>;
    add(order: Order): Promise<void>;
    update(order: Order): Promise<void>;
}

// Use in your domain/application layer
async function confirmOrder(
    orderId: OrderId,
    repository: OrderRepository
): Promise<void> {
    const order = await repository.get(orderId);
    order.confirm();
    await repository.update(order);
}
```

### UnitOfWork

Interface for transaction management. Controls transaction propagation and provides access to the underlying database client.

```typescript
import { UnitOfWork, Propagation } from "@hexaijs/core";

// UnitOfWork is typically accessed through application context
interface OrderApplicationContext {
    getUnitOfWork(): UnitOfWork;
    getOrderRepository(): OrderRepository;
}

// Transaction propagation options
Propagation.NEW       // Start new transaction
Propagation.EXISTING  // Use existing transaction (error if none)
Propagation.NESTED    // Nested transaction (savepoint)
```

### EventStore

Interface for event sourcing scenarios. Stores and retrieves events by position.

```typescript
import { EventStore, StoredEvent } from "@hexaijs/core";

// EventStore interface for reading events
interface MyEventStore extends EventStore {
    fetch(afterPosition: number, limit?: number): Promise<{
        events: StoredEvent[];
        lastPosition: number;
    }>;
}

// StoredEvent wraps event with its position
interface StoredEvent {
    position: number;
    event: Message;
}
```

## Error Types

The package provides standard domain error types:

```typescript
import {
    DomainError,
    InvariantNotSatisfiedError,
    ValidationError,
    RepositoryError,
    ObjectNotFoundError,
    DuplicateObjectError
} from "@hexaijs/core";

// Domain invariant violations
throw new InvariantNotSatisfiedError(
    "ORDER_ALREADY_SHIPPED",
    "Cannot modify a shipped order"
);

// Field-level validation errors
throw new ValidationError(
    "email",
    "INVALID_FORMAT",
    "Email must be a valid email address"
);

// Repository errors
throw new ObjectNotFoundError("Order not found");
throw new DuplicateObjectError("Order with this ID already exists");
```

**Error hierarchy:**
- `DomainError` - Base for all domain errors
  - `InvariantNotSatisfiedError` - Business rule violations
    - `ValidationError` - Field-specific validation failures
- `RepositoryError` - Base for persistence errors
  - `ObjectNotFoundError` - Entity not found
  - `DuplicateObjectError` - Duplicate key/entity

## API Highlights

| Export | Description |
|--------|-------------|
| `Message<P>` | Base message class with headers and typed payload |
| `MessageOptions` | Options for Message constructor (`{ headers? }`) |
| `DomainEvent<P>` | Message subclass for domain events |
| `AggregateRoot<T>` | Base class for aggregates with event collection |
| `Id<T>` | Value object for typed identities |
| `Identifiable<T>` | Interface for entities with identity |
| `Repository<T>` | Interface for aggregate persistence |
| `UnitOfWork` | Interface for transaction management |
| `Propagation` | Enum for transaction propagation modes |
| `EventStore` | Interface for event store implementations |

## See Also

- [@hexaijs/application](../application/README.md) - Application layer with command handlers and context
- [@hexaijs/postgres](../postgres/README.md) - PostgreSQL implementation of UnitOfWork and EventStore
- [@hexaijs/sqlite](../sqlite/README.md) - SQLite implementation for testing
