# @hexaijs/sqlite

> SQLite transaction management for testing and lightweight use cases

## Overview

`@hexaijs/sqlite` provides an SQLite implementation of the `UnitOfWork` interface from `@hexaijs/core`. It enables transaction management against SQLite databases, making it particularly useful for fast, isolated integration tests.

The package centers around `SqliteUnitOfWork`, which wraps operations in SQLite transactions. Unlike `PostgresUnitOfWork`, it uses a simpler architecture without `AsyncLocalStorage` or propagation modes—a deliberate trade-off that favors simplicity for scenarios where a single database connection is sufficient.

The test utilities export makes it easy to spin up in-memory databases and use generic repositories for test fixtures. In-memory SQLite databases are ephemeral: they're created instantly, run entirely in RAM, and disappear when the connection closes. This makes them ideal for integration tests that need database behavior without the overhead of a real PostgreSQL server.

## When to Use SQLite vs PostgreSQL

| Scenario | Recommendation |
|----------|----------------|
| Unit/integration tests | **SQLite** - Fast, no external dependencies |
| Production database | **PostgreSQL** - Full ACID, scalability, advanced features |
| CI/CD pipelines | **SQLite** - No database setup required |
| Local development | Either - SQLite for speed, PostgreSQL for parity with production |

## Installation

```bash
npm install @hexaijs/sqlite
```

**Peer dependencies:**

```bash
npm install @hexaijs/core better-sqlite3
```

## Core Concepts

### SqliteUnitOfWork

The `SqliteUnitOfWork` implements `UnitOfWork<Database>` from `@hexaijs/core`. It manages transaction lifecycle for a given SQLite database connection.

```typescript
import Database from "better-sqlite3";
import { SqliteUnitOfWork } from "@hexaijs/sqlite";

// Create an in-memory database
const db = new Database(":memory:");

// Create unit of work
const unitOfWork = new SqliteUnitOfWork(db);
```

Unlike PostgreSQL's unit of work which accepts a client factory, `SqliteUnitOfWork` takes a pre-connected `Database` instance. This simpler model works well for SQLite's single-writer architecture.

### Transaction Execution

Use `scope()` to define a transaction boundary:

```typescript
const result = await unitOfWork.scope(async () => {
    const db = unitOfWork.getClient();
    db.prepare("INSERT INTO orders (id, status) VALUES (?, ?)").run(orderId, "pending");
    db.prepare("INSERT INTO order_items (order_id, product_id) VALUES (?, ?)").run(orderId, productId);
    return { orderId };
});
// Transaction commits if successful
```

`wrap()` is also available but deprecated. In SQLite, `scope()` delegates to `wrap()` internally — both behave identically.

```typescript
/** @deprecated Use scope() instead. */
const result = await unitOfWork.wrap(async (db) => {
    db.prepare("INSERT INTO orders (id, status) VALUES (?, ?)").run(orderId, "pending");
    return { orderId };
});
```

If an error is thrown, the transaction rolls back:

```typescript
try {
    await unitOfWork.scope(async () => {
        const db = unitOfWork.getClient();
        db.prepare("INSERT INTO orders (id, status) VALUES (?, ?)").run(orderId, "pending");
        throw new Error("Something went wrong");
    });
} catch (error) {
    // Transaction rolled back - no order was inserted
}
```

### Accessing the Client

Within a transaction, access the database through `getClient()`:

```typescript
// Inside a command handler
const db = ctx.getUnitOfWork().getClient();
db.prepare("UPDATE orders SET status = ? WHERE id = ?").run("confirmed", orderId);
```

Note: `getClient()` throws an error if called outside of a `scope()` or `wrap()` call.

### Transaction Lifecycle Hooks

Register callbacks that execute at specific points in the transaction lifecycle:

```typescript
await unitOfWork.scope(async () => {
    unitOfWork.beforeCommit(() => {
        // Validate before committing
    });

    unitOfWork.afterCommit(() => {
        // Notify after successful commit
    });

    unitOfWork.afterRollback(() => {
        // Clean up on failure
    });

    const db = unitOfWork.getClient();
    db.prepare("INSERT INTO orders (id, status) VALUES (?, ?)").run(orderId, "pending");
});
```

Hooks follow the same semantics as `@hexaijs/postgres`:

| Hook | When | On failure |
|------|------|------------|
| `beforeCommit` | Before COMMIT | Transaction rolls back instead |
| `afterCommit` | After COMMIT | Best-effort (errors → `AggregateError`) |
| `afterRollback` | After ROLLBACK | Best-effort (errors → `AggregateError`) |

Hooks are scope-local and can only be registered inside an active `scope()`.

### Nested Transactions

Nested `scope()` calls participate in the same transaction:

```typescript
await unitOfWork.scope(async () => {
    const db = unitOfWork.getClient();
    db.prepare("INSERT INTO orders (id) VALUES (?)").run("order-1");

    await unitOfWork.scope(async () => {
        const db = unitOfWork.getClient();
        db.prepare("INSERT INTO order_items (order_id) VALUES (?)").run("order-1");
    });
    // Both inserts are in the same transaction
});
// Single COMMIT at the end
```

If any nested call throws, the entire transaction rolls back:

```typescript
try {
    await unitOfWork.scope(async () => {
        const db = unitOfWork.getClient();
        db.prepare("INSERT INTO orders (id) VALUES (?)").run("order-1");

        await unitOfWork.scope(async () => {
            const db = unitOfWork.getClient();
            db.prepare("INSERT INTO order_items (order_id) VALUES (?)").run("order-1");
            throw new Error("Nested failure");
        });
    });
} catch {
    // Both inserts rolled back
}
```

## Usage

### Test Setup

Use the test utilities for fast, isolated integration tests:

```typescript
import type { Database } from "better-sqlite3";
import { SqliteUnitOfWork } from "@hexaijs/sqlite";
import { getSqliteConnection } from "@hexaijs/sqlite/test";

describe("OrderRepository", () => {
    let db: Database;
    let unitOfWork: SqliteUnitOfWork;

    beforeEach(() => {
        // Create fresh in-memory database
        db = getSqliteConnection();

        // Create schema
        db.exec(`
            CREATE TABLE orders (
                id TEXT PRIMARY KEY,
                status TEXT NOT NULL
            )
        `);

        unitOfWork = new SqliteUnitOfWork(db);
    });

    afterEach(() => {
        db.close();
    });

    it("should persist orders", async () => {
        await unitOfWork.scope(async () => {
            const db = unitOfWork.getClient();
            db.prepare("INSERT INTO orders (id, status) VALUES (?, ?)").run("order-1", "pending");
        });

        const result = db.prepare("SELECT * FROM orders WHERE id = ?").get("order-1") as any;
        expect(result.status).toBe("pending");
    });
});
```

### SqliteRepositoryForTest

The `SqliteRepositoryForTest` provides a generic repository implementation for test fixtures. It implements the `Repository<E>` interface from `@hexaijs/core`.

```typescript
import { SqliteRepositoryForTest, getSqliteConnection } from "@hexaijs/sqlite/test";
import { Identifiable, IdOf } from "@hexaijs/core";

// Define your entity
class Order implements Identifiable<OrderId> {
    constructor(
        private id: OrderId,
        private status: string
    ) {}

    getId(): OrderId {
        return this.id;
    }

    getStatus(): string {
        return this.status;
    }
}

// Define memento for serialization
interface OrderMemento {
    id: string;
    status: string;
}

// Create repository
const db = getSqliteConnection();
const orderRepository = new SqliteRepositoryForTest<Order, OrderMemento>(db, {
    namespace: "orders",
    hydrate: (m) => new Order(new OrderId(m.id), m.status),
    dehydrate: (e) => ({ id: e.getId().getValue(), status: e.getStatus() }),
});

// Use repository
await orderRepository.add(new Order(new OrderId("order-1"), "pending"));
const order = await orderRepository.get(new OrderId("order-1"));
await orderRepository.update(order);
const count = await orderRepository.count();
```

The repository automatically creates its table on first use. Each repository uses a separate table identified by its namespace.

### File-Based Database

For scenarios requiring persistence across test runs or debugging:

```typescript
import { getSqliteConnection } from "@hexaijs/sqlite/test";

// File-based database instead of in-memory
const db = getSqliteConnection("./test-database.sqlite");
```

## API Highlights

| Export | Description |
|--------|-------------|
| `SqliteUnitOfWork` | Transaction management implementing `UnitOfWork<Database>` |

**From `@hexaijs/sqlite/test`:**

| Export | Description |
|--------|-------------|
| `getSqliteConnection` | Creates SQLite connection (in-memory by default) |
| `SqliteRepositoryForTest` | Generic repository for test fixtures |

## See Also

- [@hexaijs/core](../core/README.md) - Core interfaces (`UnitOfWork`, `Repository`)
- [@hexaijs/postgres](../postgres/README.md) - PostgreSQL implementation for production
- [@hexaijs/application](../application/README.md) - Application context that provides `getUnitOfWork()`
