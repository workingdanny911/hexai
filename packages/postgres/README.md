# @hexaijs/postgres

> PostgreSQL infrastructure for transaction management, event storage, and migrations

## Overview

`@hexaijs/postgres` provides PostgreSQL implementations of the core infrastructure interfaces defined in `@hexaijs/core`. It bridges your domain layer to PostgreSQL with production-ready transaction management.

The package centers around `PostgresUnitOfWork`, which manages database transactions across your command handlers. It uses `AsyncLocalStorage` to maintain transaction context throughout async operations, ensuring all database operations within a handler share the same transaction. If your handler succeeds, the transaction commits automatically. If it throws, the transaction rolls back.

Beyond transactions, the package includes `PostgresEventStore` for storing domain events, a migration runner that integrates with `node-pg-migrate`, and configuration utilities for managing connection settings through environment variables.

## Installation

```bash
npm install @hexaijs/postgres
```

**Peer dependencies:**

```bash
npm install @hexaijs/core @hexaijs/utils pg
```

## Core Concepts

### PostgresUnitOfWork

The `PostgresUnitOfWork` implements `UnitOfWork` from `@hexaijs/core`. It manages transaction lifecycle and provides access to the database client.

```typescript
import * as pg from "pg";
import { createPostgresUnitOfWork } from "@hexaijs/postgres";

// From connection pool (recommended for production)
const pool = new pg.Pool({ connectionString: "postgres://..." });
const unitOfWork = createPostgresUnitOfWork(pool);

// From connection string
const unitOfWork = createPostgresUnitOfWork("postgres://user:pass@localhost:5432/mydb");

// From PostgresConfig
const unitOfWork = createPostgresUnitOfWork(PostgresConfig.fromEnv("DB"));
```

For advanced use cases, you can use `DefaultPostgresUnitOfWork` directly:

```typescript
import { DefaultPostgresUnitOfWork } from "@hexaijs/postgres";

// Custom client factory with custom cleanup
const unitOfWork = new DefaultPostgresUnitOfWork(
    () => new pg.Client({ connectionString: "postgres://..." }),
    (client) => client.end()  // cleanup function
);
```

The client factory creates a new client for each transaction. The optional cleanup function runs after the transaction completes (commit or rollback).

### Transaction Execution

Use `scope()` to define a transaction boundary. Client access happens through `withClient()`:

```typescript
// Execute within a transaction
const result = await unitOfWork.scope(async () => {
    await unitOfWork.withClient(async (client) => {
        await client.query("INSERT INTO orders (id, status) VALUES ($1, $2)", [orderId, "pending"]);
        await client.query("INSERT INTO order_items (order_id, product_id) VALUES ($1, $2)", [orderId, productId]);
    });
    return { orderId };
});
```

#### Lazy Transaction Initialization

`scope()` does **not** issue `BEGIN` immediately. The transaction starts lazily on the first `withClient()` call. This means if the scope exits without any client access, no database connection is acquired at all.

```typescript
await unitOfWork.scope(async () => {
    // No BEGIN yet - transaction hasn't started

    if (!needsUpdate) return;  // Early exit: no connection acquired

    await unitOfWork.withClient(async (client) => {
        // BEGIN is issued here, on first withClient() call
        await client.query("UPDATE orders SET status = $1 WHERE id = $2", ["confirmed", orderId]);
    });
    // COMMIT on scope exit
});
```

#### wrap() (Deprecated)

`wrap()` is the legacy API that eagerly starts a transaction and passes the client directly:

```typescript
/** @deprecated Use scope() for transaction boundaries and withClient() for client access. */
const result = await unitOfWork.wrap(async (client) => {
    await client.query("INSERT INTO orders (id, status) VALUES ($1, $2)", [orderId, "pending"]);
    return { orderId };
});
```

### Client Access Without Transaction

Use `withClient()` for operations without transaction overhead. Useful for read-only queries or when you need direct client access.

```typescript
// Simple read without transaction (autocommit)
const user = await unitOfWork.withClient(async (client) => {
    const result = await client.query("SELECT * FROM users WHERE id = $1", [userId]);
    return result.rows[0];
});
```

The `withClient()` method is context-aware:

| Context | Behavior |
|---------|----------|
| Outside transaction | New connection from factory → work → cleanup |
| Inside transaction | Reuses existing transaction's client |

This means you can safely use `withClient()` anywhere in your code:

```typescript
// Outside any transaction - gets its own connection
const users = await unitOfWork.withClient(async (client) => {
    return await client.query("SELECT * FROM users");
});

// Inside scope() - reuses the transaction's client
await unitOfWork.scope(async () => {
    await unitOfWork.withClient(async (client) => {
        await client.query("INSERT INTO orders (id) VALUES ($1)", [orderId]);
    });

    // Same transaction, sees uncommitted changes
    const order = await unitOfWork.withClient(async (client) => {
        return await client.query("SELECT * FROM orders WHERE id = $1", [orderId]);
    });
});
```

**When to use which method:**

| Method | Transaction | Connection | Use Case |
|--------|-------------|------------|----------|
| `scope()` | Yes (lazy) | On first `withClient()` | Commands — recommended |
| `wrap()` | Yes (eager) | Immediate | Legacy — deprecated |
| `withClient()` | No | Per-call | Queries (SELECT) |

### Transaction Propagation

Control how nested operations participate in transactions using `Propagation`:

```typescript
import { Propagation } from "@hexaijs/core";

// EXISTING (default): Join current transaction, or create new if none exists
await unitOfWork.scope(async () => {
    await unitOfWork.scope(async () => {
        // Same transaction as outer
    }, { propagation: Propagation.EXISTING });
});

// NEW: Always start a new transaction
await unitOfWork.scope(async () => {
    await unitOfWork.scope(async () => {
        // Independent transaction with separate connection
    }, { propagation: Propagation.NEW });
});

// NESTED: Create a savepoint within the current transaction
await unitOfWork.scope(async () => {
    try {
        await unitOfWork.scope(async () => {
            // Runs in a savepoint
            throw new Error("Rollback this part only");
        }, { propagation: Propagation.NESTED });
    } catch {
        // Savepoint rolled back, outer transaction continues
    }
});
```

### Isolation Levels

Configure transaction isolation levels when stricter guarantees are needed:

```typescript
import { IsolationLevel } from "@hexaijs/postgres";

await unitOfWork.scope(async () => {
    await unitOfWork.withClient(async (client) => {
        // Serializable isolation prevents phantom reads
        const result = await client.query("SELECT * FROM inventory WHERE product_id = $1", [productId]);
        // ...
    });
}, { isolationLevel: IsolationLevel.SERIALIZABLE });
```

Available levels:
- `IsolationLevel.READ_UNCOMMITTED`
- `IsolationLevel.READ_COMMITTED` (PostgreSQL default)
- `IsolationLevel.REPEATABLE_READ`
- `IsolationLevel.SERIALIZABLE`

### PostgresEventStore

The `PostgresEventStore` implements `EventStore` from `@hexaijs/core` for storing and retrieving domain events.

```typescript
import { PostgresEventStore } from "@hexaijs/postgres";
import { DomainEvent } from "@hexaijs/core";

class OrderPlaced extends DomainEvent<{ orderId: string; customerId: string }> {
    static readonly type = "order.order-placed";
}

// Create event store with the transaction client
const client = unitOfWork.getClient();
const eventStore = new PostgresEventStore(client);

// Store events
const stored = await eventStore.store(new OrderPlaced({
    orderId: "order-123",
    customerId: "customer-456"
}));
console.log(stored.position);  // Event position in the store

// Store multiple events atomically
const storedEvents = await eventStore.storeAll([event1, event2, event3]);

// Fetch events for replay or projections
const { events, lastPosition } = await eventStore.fetch(0, 100);
// events: StoredEvent[] - events after position 0, up to 100
// lastPosition: number - highest position in store (for catchup detection)
```

Custom table name:

```typescript
const eventStore = new PostgresEventStore(client, {
    tableName: "my_bounded_context_events"
});
```

## Usage

### Running Migrations

The package provides a migration runner that supports both SQL and JavaScript migration formats.

```typescript
import { runMigrations } from "@hexaijs/postgres";

// Run JavaScript migrations (node-pg-migrate format)
await runMigrations({
    url: "postgres://user:pass@localhost:5432/mydb",
    dir: "./migrations",
});

// With namespace (creates separate migrations table)
await runMigrations({
    url: "postgres://user:pass@localhost:5432/mydb",
    dir: "./migrations/orders",
    namespace: "orders",  // Table: hexai__migrations_orders
});

// SQL-based migrations (directories with migration.sql files)
// migrations/
//   001_create_orders/
//     migration.sql
//   002_add_status/
//     migration.sql
await runMigrations({
    url: dbConfig,
    dir: "./migrations",
});
```

Run built-in hexai migrations (creates the event store table):

```typescript
import { runHexaiMigrations } from "@hexaijs/postgres";

await runHexaiMigrations("postgres://user:pass@localhost:5432/mydb");
```

### Configuration

`PostgresConfig` provides immutable configuration management:

```typescript
import { PostgresConfig } from "@hexaijs/postgres";

// From connection URL
const config = PostgresConfig.fromUrl("postgres://user:pass@localhost:5432/mydb");

// From environment variables
// URL mode: reads MY_DB_URL
const config = PostgresConfig.fromEnv("MY_DB");

// Fields mode: reads MY_DB_HOST, MY_DB_PORT, MY_DB_DATABASE, MY_DB_USER, MY_DB_PASSWORD
const config = PostgresConfig.fromEnv("MY_DB", { mode: "fields" });

// Builder pattern for modifications (returns new instance)
const testConfig = config
    .withDatabase("mydb_test")
    .withPoolSize(5);

// Use as connection string
new pg.Client({ connectionString: config.toString() });
```

With `defineConfig` from `@hexaijs/utils`:

```typescript
import { defineConfig } from "@hexaijs/utils/config";
import { postgresConfig } from "@hexaijs/postgres";

const getConfig = defineConfig({
    db: postgresConfig("ORDER_DB"),           // reads ORDER_DB_URL
    readReplica: postgresConfig("REPLICA_DB", "fields"),  // reads individual fields
});

const config = getConfig();
config.db.host;        // "localhost"
config.db.toString();  // "postgres://..."
```

### Database Utilities

Helper classes for database management and testing:

```typescript
import { DatabaseManager, TableManager, ensureConnection } from "@hexaijs/postgres";

// Create/drop databases
const dbManager = new DatabaseManager("postgres://user:pass@localhost:5432/postgres");
await dbManager.createDatabase("my_new_db");
await dbManager.dropDatabase("my_old_db");
await dbManager.close();

// Table operations
const tableManager = new TableManager(client);
await tableManager.tableExists("orders");
await tableManager.truncateTable("orders");
await tableManager.dropAllTables();

// Ensure client is connected
await ensureConnection(client);  // Safe to call multiple times
```

### PostgresUnitOfWorkForTesting

A test-specific `PostgresUnitOfWork` implementation that runs inside an external transaction. This allows tests to rollback all changes after each test, keeping the database clean without truncating tables.

```typescript
import { PostgresUnitOfWorkForTesting } from "@hexaijs/postgres/test";
import { Client } from "pg";

describe("OrderService", () => {
    let client: Client;
    let uow: PostgresUnitOfWorkForTesting;

    beforeEach(async () => {
        client = new Client({ connectionString: "postgres://..." });
        await client.connect();
        await client.query("BEGIN");  // Start external transaction
        uow = new PostgresUnitOfWorkForTesting(client);
    });

    afterEach(async () => {
        await client.query("ROLLBACK");  // Rollback all changes
        await client.end();
    });

    it("should create order", async () => {
        await uow.scope(async () => {
            await uow.withClient(async (c) => {
                await c.query("INSERT INTO orders (id) VALUES ($1)", ["order-1"]);
            });
        });

        // Verify within the same transaction
        const result = await client.query("SELECT * FROM orders");
        expect(result.rows).toHaveLength(1);
    });

    // After this test, ROLLBACK cleans up - no data persists
});
```

**How it works:**

| Operation | Production (`PostgresUnitOfWork`) | Testing (`PostgresUnitOfWorkForTesting`) |
|-----------|-----------------------------------|------------------------------------------|
| Start | `BEGIN` | `SAVEPOINT` |
| Commit | `COMMIT` | `RELEASE SAVEPOINT` |
| Rollback | `ROLLBACK` | `ROLLBACK TO SAVEPOINT` |

**Key behaviors:**

- **`withClient()` method**: Uses the test client directly, always within the external transaction context.
- **abortError propagation**: When a nested `EXISTING` operation throws (even if caught), the entire transaction is marked as aborted and will rollback - matching production behavior.
- **NESTED savepoints**: `Propagation.NESTED` creates independent savepoints that can rollback without affecting the parent.
- **Propagation.NEW**: Logs a warning and creates a new savepoint instead (true separate transactions are not possible within the external transaction).
- **Single client**: Does not support concurrent `Promise.all` wrap calls (PostgreSQL limitation with single connection).

```typescript
// abortError behavior - matches production
await uow.scope(async () => {
    await insertOrder(1);

    try {
        await uow.scope(async () => {
            throw new Error("fails");
        });
    } catch {
        // Caught, but transaction is already marked as aborted
    }

    await insertOrder(2);  // Executes, but will be rolled back
});
// Result: Both orders rolled back (abortError propagation)

// NESTED savepoint - independent rollback
await uow.scope(async () => {
    await insertOrder(1);

    try {
        await uow.scope(async () => {
            await insertOrder(2);
            throw new Error("fails");
        }, { propagation: Propagation.NESTED });
    } catch {
        // Only savepoint rolled back
    }

    await insertOrder(3);
});
// Result: Orders 1 and 3 committed, order 2 rolled back
```

## API Highlights

| Export | Description |
|--------|-------------|
| `createPostgresUnitOfWork` | Factory function to create PostgresUnitOfWork from Pool or Config |
| `PostgresUnitOfWork` | Interface extending UnitOfWork with `withClient()` method |
| `DefaultPostgresUnitOfWork` | Default implementation of PostgresUnitOfWork with transaction management |
| `PostgresUnitOfWorkForTesting` | Test-specific PostgresUnitOfWork that runs inside external transaction |
| `PostgresEventStore` | Event store implementation with batch insert support |
| `PostgresConfig` | Immutable configuration with builder pattern |
| `postgresConfig` | Config spec for `defineConfig` integration |
| `runMigrations` | Migration runner for SQL and JS migrations |
| `runHexaiMigrations` | Runs built-in hexai migrations |
| `DatabaseManager` | Create/drop databases |
| `TableManager` | Table operations (truncate, drop, schema info) |
| `IsolationLevel` | Transaction isolation level enum |
| `ensureConnection` | Safe connection helper |

## Migration Guide

### v0.5.1 → v0.6.0

**New API: `scope()` replaces `wrap()` for transaction boundaries**

`scope()` is the new recommended way to define transaction boundaries. Unlike `wrap()`, it does not pass the database client directly — use `withClient()` instead.

```typescript
// Before (v0.5.1) - wrap() passes client directly
await unitOfWork.wrap(async (client) => {
    await client.query("INSERT INTO orders (id) VALUES ($1)", [orderId]);
});

// After (v0.6.0) - scope() + withClient()
await unitOfWork.scope(async () => {
    await unitOfWork.withClient(async (client) => {
        await client.query("INSERT INTO orders (id) VALUES ($1)", [orderId]);
    });
});
```

**Key differences:**

| Aspect | `wrap()` | `scope()` |
|--------|----------|-----------|
| Transaction start | Eager (`BEGIN` immediately) | Lazy (`BEGIN` on first `withClient()`) |
| Client access | Passed as callback argument | Via `withClient()` |
| Status | Deprecated | Recommended |

**`wrap()` is deprecated** but continues to work. No urgent migration needed — update at your own pace.

**Peer dependency:** Update `@hexaijs/core` to `^0.7.0`.

### v0.3.x → v0.4.0

**Breaking Change: `PostgresUnitOfWork` class renamed**

`PostgresUnitOfWork` is now an interface. The actual implementation is `DefaultPostgresUnitOfWork`.

```typescript
// Before (v0.3.x)
import { PostgresUnitOfWork } from "@hexaijs/postgres";
const uow = new PostgresUnitOfWork(factory, cleanup);

// After (v0.4.0)
import { DefaultPostgresUnitOfWork } from "@hexaijs/postgres";
const uow = new DefaultPostgresUnitOfWork(factory, cleanup);

// Type usage (unchanged)
function doSomething(uow: PostgresUnitOfWork) { ... }
```

**Why this change?**

The interface allows both `DefaultPostgresUnitOfWork` and `PostgresUnitOfWorkForTesting` to be used interchangeably where `PostgresUnitOfWork` type is expected.

**Breaking Change: `query()` renamed to `withClient()`**

The `query()` method has been renamed to `withClient()` for clarity. The name `query()` was confusing because inside the callback, you also call `client.query()`.

```typescript
// Before (v0.3.x)
const user = await unitOfWork.query(async (client) => {
    return client.query("SELECT * FROM users WHERE id = $1", [userId]);
});

// After (v0.4.0)
const user = await unitOfWork.withClient(async (client) => {
    return client.query("SELECT * FROM users WHERE id = $1", [userId]);
});
```

The `QueryableUnitOfWork` interface has been removed from `@hexaijs/core`. The `withClient()` method is now specific to `@hexaijs/postgres`.

## See Also

- [@hexaijs/core](../core/README.md) - Core interfaces (`UnitOfWork`, `EventStore`, `Propagation`)
- [@hexaijs/sqlite](../sqlite/README.md) - SQLite implementation for testing
- [@hexaijs/application](../application/README.md) - Application context that provides `getUnitOfWork()`
