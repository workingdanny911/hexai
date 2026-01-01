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
import { PostgresUnitOfWork } from "@hexaijs/postgres";

// Create with a client factory
const pool = new pg.Pool({ connectionString: "postgres://..." });
const unitOfWork = new PostgresUnitOfWork(
    () => new pg.Client({ connectionString: "postgres://..." }),
    (client) => client.end()  // cleanup function
);

// Or use a connection pool
const pooledUnitOfWork = new PostgresUnitOfWork(
    async () => await pool.connect(),
    (client) => (client as pg.PoolClient).release()
);
```

The client factory creates a new client for each transaction. The optional cleanup function runs after the transaction completes (commit or rollback).

### Transaction Execution

Use `wrap()` to execute operations within a transaction:

```typescript
import { Propagation } from "@hexaijs/core";

// Execute within a transaction
const result = await unitOfWork.wrap(async (client) => {
    await client.query("INSERT INTO orders (id, status) VALUES ($1, $2)", [orderId, "pending"]);
    await client.query("INSERT INTO order_items (order_id, product_id) VALUES ($1, $2)", [orderId, productId]);
    return { orderId };
});
```

Within a command handler, access the client through `getClient()`:

```typescript
// Inside a command handler
const client = ctx.getUnitOfWork().getClient();
await client.query("UPDATE orders SET status = $1 WHERE id = $2", ["confirmed", orderId]);
```

### Transaction Propagation

Control how nested operations participate in transactions using `Propagation`:

```typescript
import { Propagation } from "@hexaijs/core";

// EXISTING (default): Join current transaction, or create new if none exists
await unitOfWork.wrap(async () => {
    // This joins the outer transaction
    await unitOfWork.wrap(async (client) => {
        // Same transaction as outer
    }, { propagation: Propagation.EXISTING });
});

// NEW: Always start a new transaction
await unitOfWork.wrap(async () => {
    // This runs in a separate transaction
    await unitOfWork.wrap(async (client) => {
        // Independent transaction
    }, { propagation: Propagation.NEW });
});

// NESTED: Create a savepoint within the current transaction
await unitOfWork.wrap(async () => {
    try {
        await unitOfWork.wrap(async (client) => {
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

await unitOfWork.wrap(async (client) => {
    // Serializable isolation prevents phantom reads
    const result = await client.query("SELECT * FROM inventory WHERE product_id = $1", [productId]);
    // ...
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

### Test Fixtures

The package exports test utilities from `@hexaijs/postgres/test`:

```typescript
import { useDatabase, useClient, useTableManager } from "@hexaijs/postgres/test";

describe("OrderRepository", () => {
    // Creates database before tests, drops after
    const dbUrl = useDatabase("order_test_db");

    // Provides connected client
    const client = useClient("order_test_db");

    it("should persist orders", async () => {
        // Use client for assertions
        const result = await client.query("SELECT * FROM orders");
        expect(result.rows).toHaveLength(1);
    });
});
```

## API Highlights

| Export | Description |
|--------|-------------|
| `PostgresUnitOfWork` | Transaction management with `AsyncLocalStorage` context |
| `PostgresEventStore` | Event store implementation with batch insert support |
| `PostgresConfig` | Immutable configuration with builder pattern |
| `postgresConfig` | Config spec for `defineConfig` integration |
| `runMigrations` | Migration runner for SQL and JS migrations |
| `runHexaiMigrations` | Runs built-in hexai migrations |
| `DatabaseManager` | Create/drop databases |
| `TableManager` | Table operations (truncate, drop, schema info) |
| `IsolationLevel` | Transaction isolation level enum |
| `ensureConnection` | Safe connection helper |

## See Also

- [@hexaijs/core](../core/README.md) - Core interfaces (`UnitOfWork`, `EventStore`, `Propagation`)
- [@hexaijs/sqlite](../sqlite/README.md) - SQLite implementation for testing
- [@hexaijs/application](../application/README.md) - Application context that provides `getUnitOfWork()`
