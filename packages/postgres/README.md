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
npm install @hexaijs/core ezcfg pg
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

### Transaction Lifecycle Hooks

Register callbacks that execute at specific points in the transaction lifecycle:

```typescript
await unitOfWork.scope(async () => {
    // Validate before committing
    unitOfWork.beforeCommit(async () => {
        const count = await unitOfWork.withClient(async (client) => {
            const result = await client.query("SELECT count(*) FROM order_items WHERE order_id = $1", [orderId]);
            return parseInt(result.rows[0].count);
        });
        if (count === 0) throw new Error("Order must have at least one item");
    });

    // Flush buffered work after validation and still inside this transaction
    unitOfWork.beforeCommit(async () => {
        await unitOfWork.withClient(async (client) => {
            await client.query("INSERT INTO order_audit_log (order_id) VALUES ($1)", [orderId]);
        });
    }, { phase: "drain" });

    // Send notification after successful commit
    unitOfWork.afterCommit(async () => {
        await notificationService.send("Order confirmed");
    });

    // Clean up on failure
    unitOfWork.afterRollback(async () => {
        await fileStorage.deleteUploadedFiles(orderId);
    });

    await unitOfWork.withClient(async (client) => {
        await client.query("UPDATE orders SET status = $1 WHERE id = $2", ["confirmed", orderId]);
    });
});
```

**Key behaviors:**

- `beforeCommit` hooks run **before** the `COMMIT` — if any hook throws, the transaction rolls back instead
- `beforeCommit` drain hooks run after ordinary `beforeCommit` hooks and still inside the same transaction
- `afterCommit` and `afterRollback` hooks run **best-effort**: all hooks execute even if some fail, with errors collected into an `AggregateError`
- Hooks are **scope-local**: registered within a `scope()`, cleared after the transaction completes
- `Propagation.NESTED` scopes maintain their own independent hook registries
- Calling hook registration methods outside a `scope()` throws an error

### Postgres Transaction Capabilities

`DefaultPostgresUnitOfWork` also provides Postgres-local transaction
capabilities for advanced coordination inside a transaction. These capabilities
are intentionally separate from the base `PostgresUnitOfWork` interface so
callers can depend only on the features they need.

#### CommitControl

Use `CommitControl` when a transaction must roll back while preserving the
callback's return value. This is useful for value-based error contracts, such as
returning an error result instead of throwing.

```typescript
import {
    CommitControl,
    createPostgresUnitOfWork,
} from "@hexaijs/postgres";

const unitOfWork = createPostgresUnitOfWork(pool);
const commitControl = unitOfWork as typeof unitOfWork & CommitControl;

const result = await unitOfWork.scope(async () => {
    const result = await handleCommand();

    if (result.isError()) {
        commitControl.preventCommit(result.error);
    }

    return result;
});
```

`preventCommit()` marks the root transaction as non-committable. The scope still
returns normally, but the transaction rolls back during finalization.

If an `EXISTING` nested scope throws and the root scope catches that error, the
root scope must either rethrow or call `preventCommit()`. Otherwise,
`DefaultPostgresUnitOfWork` rejects root finalization with
`TransactionAbortedError` to prevent accidentally committing a transaction that
was already aborted.

`CommitControl` is not available inside `Propagation.NESTED` savepoints because
savepoints do not own the root transaction outcome.

#### TransactionResourceAware

Use `TransactionResourceAware` to store transaction-local resources without
threading them through every call. Resources are cleared when the transaction
commits or rolls back.

```typescript
import { DomainEvent } from "@hexaijs/core";
import {
    TransactionResourceAware,
    createTransactionResourceKey,
} from "@hexaijs/postgres";

const eventsKey = createTransactionResourceKey<DomainEvent[]>(
    "buffered-domain-events"
);
const resources = unitOfWork as typeof unitOfWork & TransactionResourceAware;

await unitOfWork.scope(async () => {
    const events = resources.getOrCreateTransactionResource(
        eventsKey,
        () => []
    );

    events.push(...aggregate.flushEvents());
});
```

Transaction resources are root-transaction scoped and are not available inside
`Propagation.NESTED` savepoints.

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

The `PostgresEventStore` implements `EventStore` from `@hexaijs/core` for storing and retrieving domain events. It accepts a `PostgresUnitOfWork`, so it automatically participates in the current transaction when used inside `scope()`.

```typescript
import { PostgresEventStore } from "@hexaijs/postgres";
import { DomainEvent } from "@hexaijs/core";

class OrderPlaced extends DomainEvent<{ orderId: string; customerId: string }> {
    static readonly type = "order.order-placed";
}

// Create event store with UnitOfWork
const eventStore = new PostgresEventStore(unitOfWork);

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

Event positions are allocated from a transaction-scoped counter row, not from a
PostgreSQL sequence. This keeps positions safe for projection checkpoints: a
transaction holding a lower position must commit or roll back before a higher
position can be assigned. The trade-off is that concurrent event appends
serialize at position allocation until the surrounding transaction finishes.

When appending inside a larger unit-of-work scope, prefer doing it near the end
of the transaction so the counter row lock is not held while unrelated work is
still running.

Operational note: the built-in migration that introduces the counter removes the
old `position` column default. Use a write-stop deployment order: stop old
writers, run `runHexaiMigrations()`, then start new writers. Old writers fail
after the migration because they omit `position`; new writers fail before the
migration because the counter table does not exist yet. The migration briefly
takes an `ACCESS EXCLUSIVE` lock on the event table, so long-running readers can
delay it; consider setting database-level `lock_timeout` and
`statement_timeout` for production migration runs.

Inside a transaction scope, the event store shares the same client with repositories:

```typescript
await unitOfWork.scope(async () => {
    await repository.save(aggregate);
    await eventStore.storeAll(aggregate.getEventsOccurred());
    // Both operations commit or rollback together
});
```

#### Streaming Events

Use `stream()` for processing large volumes of events (e.g., projection rebuilds). It returns an `AsyncGenerator` that fetches events in batches:

```typescript
for await (const event of eventStore.stream(0, 500)) {
    await projector.apply(event);
}
```

The stream prefetches the next batch while yielding current events, hiding DB latency behind event processing time. Early termination (e.g., `break`) is safe — pending prefetch promises are handled gracefully.

#### Custom Table Name

```typescript
const eventStore = new PostgresEventStore(unitOfWork, {
    tableName: "my_bounded_context_events"
});
```

Custom event tables need a matching position counter table. By default the
counter table name is `<event_table>_position_counter`. If you override it,
create and seed that table before writing events:

```sql
CREATE TABLE my_bounded_context_event_positions (
    id INTEGER PRIMARY KEY DEFAULT 1,
    last_position BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT my_bounded_context_event_positions_singleton
        CHECK (id = 1)
);

INSERT INTO my_bounded_context_event_positions (id, last_position)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;
```

For an existing custom event table, seed `last_position` from
`COALESCE(MAX(position), 0)` instead of `0`. If that table used a sequence-backed
`position` default, drop the default after the counter is seeded so future writes
must use the counter-allocated position.

```typescript
const eventStore = new PostgresEventStore(unitOfWork, {
    tableName: "my_bounded_context_events",
    positionCounterTableName: "my_bounded_context_event_positions"
});
```

### Projections

`@hexaijs/postgres/projection` provides a PostgreSQL projection engine for building read models from the `PostgresEventStore` event stream. Projection APIs live in a subpath so the root `@hexaijs/postgres` surface stays focused on transaction, event-store, and migration primitives.

Run the projection checkpoint migration before starting projection workers:

```typescript
import { runProjectionMigrations } from "@hexaijs/postgres/projection";

await runProjectionMigrations("postgres://user:pass@localhost:5432/mydb");
```

Define a read model with selectors:

```typescript
import {
    SelectorBasedReadModel,
    When,
    eventTypeMatches,
} from "@hexaijs/postgres/projection";

import type { StoredEvent } from "@hexaijs/core";
import type { ClientBase } from "pg";

class OrderSummaryReadModel extends SelectorBasedReadModel {
    readonly name = "order-summary";
    readonly version = 1;

    @When(eventTypeMatches("order.placed"))
    async onOrderPlaced(
        storedEvent: StoredEvent,
        client: ClientBase
    ): Promise<void> {
        const { orderId } = storedEvent.event.getPayload();
        await client.query(
            "INSERT INTO read_order_summary (order_id, position) VALUES ($1, $2)",
            [orderId, storedEvent.position]
        );
    }

    async reset(client: ClientBase): Promise<void> {
        await client.query("TRUNCATE read_order_summary");
    }
}
```

Start the engine with the event store and unit of work:

```typescript
import * as pg from "pg";
import {
    PostgresEventStore,
    createPostgresUnitOfWork,
} from "@hexaijs/postgres";
import { ProjectionEngine } from "@hexaijs/postgres/projection";

const pool = new pg.Pool({ connectionString: "postgres://..." });
const unitOfWork = createPostgresUnitOfWork(pool);
const eventStore = new PostgresEventStore(unitOfWork);

const logger = {
    pollError: console.error,
    runnerIsolated: console.error,
    runnerRetrying: console.warn,
    rebuildStarted: console.info,
    rebuildProgress: console.info,
    rebuildComplete: console.info,
    rebuildError: console.error,
    coordinatorStarted: console.info,
    coordinatorComplete: console.info,
    rebuildRetrying: console.warn,
    singleFallbackStarted: console.warn,
};

const engine = new ProjectionEngine(eventStore, unitOfWork, logger);
engine.register(new OrderSummaryReadModel());

await engine.start();

const wakeQueue = engine.createWakeQueue();

await unitOfWork.scope(async () => {
    // Store domain changes and events here.
    unitOfWork.afterCommit(() => wakeQueue.wake());
});
```

When a read model version changes, the engine resets that projection and rebuilds it from the event stream. Failed live events act as an ordering barrier: the runner does not advance to later events until the failed position succeeds or the projection is isolated.

**Processing is effectively-once.** The engine commits the read model write and the projection checkpoint in a single transaction, so a crash before commit replays the event rather than skipping it. Within that same transaction it also locks and reads the committed checkpoint (`SELECT ... FOR UPDATE`) and skips events already covered, so an in-process retry after a commit-ambiguous failure cannot re-apply an already-committed event. Keep `apply()` idempotent as defense-in-depth (prefer upserts / `ON CONFLICT`) — the guard relies on read model writes going through the provided transactional client.

**Scope and ownership.** This engine targets single-process, single-owner execution: exactly one process owns projection workers for a given database. Registering the same read model name twice on one engine fails fast. Multi-process ownership (lease, fencing, checkpoint compare-and-swap) is not yet provided. The engine runs each apply/checkpoint in its own transaction (`Propagation.NEW`), so it is safe to trigger `poll()` from an `afterCommit` hook without entangling projection writes with your command transaction.

See [`docs/projection.md`](./docs/projection.md) for the projection architecture, delivery semantics, failure handling, and rebuild behavior.

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
| `CommitControl` | Postgres-local capability for marking the current transaction as rollback-only while preserving the callback result |
| `TransactionResourceAware` | Postgres-local capability for transaction-scoped resources |
| `createTransactionResourceKey` | Creates typed keys for transaction-scoped resources |
| `TransactionAbortedError` | Error thrown when an aborted root transaction would otherwise finalize normally |
| `UnsupportedNestedTransactionCapabilityError` | Error thrown when root-only transaction capabilities are used inside a nested savepoint |
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

### v0.6.0 → v0.8.0

**New: Transaction lifecycle hooks**

`beforeCommit()`, `afterCommit()`, and `afterRollback()` are now available on `PostgresUnitOfWork`:

```typescript
await unitOfWork.scope(async () => {
    unitOfWork.beforeCommit(async () => { /* validate */ });
    unitOfWork.beforeCommit(async () => { /* flush */ }, { phase: "drain" });
    unitOfWork.afterCommit(async () => { /* notify */ });
    unitOfWork.afterRollback(async () => { /* cleanup */ });

    await unitOfWork.withClient(async (client) => {
        await client.query("INSERT INTO orders ...", [...]);
    });
});
```

**Peer dependency:** Update `@hexaijs/core` to `^0.8.0`.

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
