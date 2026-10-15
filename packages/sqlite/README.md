# @hexaijs/sqlite

> SQLite unit of work and test helpers for hexai

`@hexaijs/sqlite` implements the `UnitOfWork` contract of
[`@hexaijs/core`](../core/README.md) on SQLite with
[`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3). A unit of work
runs your database writes in one transaction per scope and commits or rolls
back when the scope ends. The package also ships test helpers: an in-memory
connection factory and a generic repository for test fixtures. Use it for fast,
isolated integration tests, or for small applications that need only one
database connection.

`SqliteUnitOfWork` is deliberately simpler than `PostgresUnitOfWork` from
[`@hexaijs/postgres`](../postgres/README.md): it uses no `AsyncLocalStorage`
and has no propagation modes. See
[Differences from @hexaijs/postgres](#differences-from-hexaijspostgres).

## When to use SQLite vs PostgreSQL

| Scenario | Recommendation |
|----------|----------------|
| Unit and integration tests | **SQLite**: fast, no database server needed |
| Production database | **PostgreSQL**: concurrent writers, plus the event store and projections of `@hexaijs/postgres` |
| CI pipelines | **SQLite**: no database setup required |
| Local development | Either: SQLite for speed, PostgreSQL for parity with production |

## Installation

```bash
npm install @hexaijs/sqlite @hexaijs/core better-sqlite3
```

| Peer dependency | Used for |
|-----------------|----------|
| `@hexaijs/core` | Core contracts such as `UnitOfWork`, `Repository` and `TransactionHooks` |
| `better-sqlite3` | The SQLite driver |

The supported version ranges are the `peerDependencies` in this package's
`package.json`.

## Quick start

```typescript
import Database from "better-sqlite3";
import { SqliteUnitOfWork } from "@hexaijs/sqlite";

const db = new Database(":memory:");
db.exec("CREATE TABLE orders (id TEXT PRIMARY KEY, status TEXT NOT NULL)");

const unitOfWork = new SqliteUnitOfWork(db);

// Commits when the callback resolves, rolls back when it rejects.
await unitOfWork.scope(async () => {
    unitOfWork
        .getClient()
        .prepare("INSERT INTO orders (id, status) VALUES (?, ?)")
        .run("order-1", "pending");
});
```

## Concepts

### Unit of work, scope and transaction

`SqliteUnitOfWork` implements `UnitOfWork<Database>` from `@hexaijs/core`. It
takes a connected `better-sqlite3` `Database` and manages transactions on it.
Unlike the Postgres unit of work, which takes a client factory, it works on that
one connection, which suits SQLite's single-writer model.

A scope is one call of `unitOfWork.scope(fn)`. The outermost scope sends
`BEGIN TRANSACTION` when it opens, then `COMMIT` when `fn` resolves or
`ROLLBACK` when it rejects. Inside the scope, `getClient()` returns the
`Database`:

```typescript
const result = await unitOfWork.scope(async () => {
    const db = unitOfWork.getClient();
    db.prepare("INSERT INTO orders (id, status) VALUES (?, ?)").run(orderId, "pending");
    db.prepare("INSERT INTO order_items (order_id, product_id) VALUES (?, ?)").run(orderId, productId);
    return { orderId };
});
// The transaction committed, and result is { orderId }
```

If the callback throws, the transaction rolls back and the scope rejects with
that error:

```typescript
try {
    await unitOfWork.scope(async () => {
        const db = unitOfWork.getClient();
        db.prepare("INSERT INTO orders (id, status) VALUES (?, ?)").run(orderId, "pending");
        throw new Error("Something went wrong");
    });
} catch (error) {
    // The transaction rolled back: no order was inserted
}
```

Your code decides where scopes begin and end; hexai's application layer does
not open one around a command for you. Open the scope where the command's work
runs, usually inside the command handler, as
[Wiring the Unit of Work and Event Publishing](../application/README.md#wiring-the-unit-of-work-and-event-publishing)
shows. If you open it outside the handler instead, around
`application.executeCommand()` or in a command interceptor, that call resolves
to an `ErrorResult` instead of rejecting when the handler fails. Turn the error
result into a rejection inside the scope, or the transaction commits the failed
command's writes; `SqliteUnitOfWork` has no `preventCommit()`.

The transaction belongs to the `Database` object, not to the async call chain.
Every `SqliteUnitOfWork` created for the same `Database`, and every scope
running on it at the same time, share one transaction, so a failure in one of
them rolls back the work of all. Run scopes on one `Database` one after
another.

`scope()` takes no options. Called through the core `UnitOfWork` type, it
accepts options such as `propagation` but ignores them.

### Nested scopes

A `scope()` inside another scope joins the same transaction:

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

If any nested scope throws, the entire transaction rolls back, even when an
outer scope catches the error:

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

When the outer scope catches the nested error and returns normally, the
transaction still rolls back, and the outer scope resolves with its callback's
result. Check your own results in that case; nothing signals the rollback.

### Transaction lifecycle hooks

Register callbacks that run at fixed points of the transaction:

```typescript
await unitOfWork.scope(async () => {
    unitOfWork.beforeCommit(() => {
        // Validate before committing
    });

    unitOfWork.beforeCommit(() => {
        // Flush buffered work after validation and before COMMIT
    }, { phase: "drain" });

    unitOfWork.afterCommit(() => {
        // Notify after a successful commit
    });

    unitOfWork.afterRollback(() => {
        // Clean up on failure
    });

    const db = unitOfWork.getClient();
    db.prepare("INSERT INTO orders (id, status) VALUES (?, ?)").run(orderId, "pending");
});
```

Hooks run through `TransactionHooks` from `@hexaijs/core`, as in
`@hexaijs/postgres`, so their order and failure handling match:

| Hook | When | On failure |
|------|------|------------|
| `beforeCommit` | Before `COMMIT` | The transaction rolls back and the scope rejects with the hook's error |
| `beforeCommit(..., { phase: "drain" })` | After the main `beforeCommit` hooks, before `COMMIT` | Same as `beforeCommit` |
| `afterCommit` | After `COMMIT` | Best-effort: all hooks run, then the scope rejects with an `AggregateError` |
| `afterRollback` | After `ROLLBACK` | Best-effort: all hooks run, then the scope rejects with an `AggregateError` whose `cause` is the error that caused the rollback |

Hooks are scope-local: register them inside an active `scope()`; they are
cleared when the transaction ends. Registering one outside a scope throws. A
main `beforeCommit` hook may register a drain hook.

Hooks run after the scope's callback has ended, so `getClient()` throws inside
them. In `beforeCommit` hooks the transaction is still open: query through the
`Database` you passed to the constructor. A `scope()` opened from a
`beforeCommit` hook rejects (see the table below).

### Differences from @hexaijs/postgres

| Behavior | `@hexaijs/sqlite` | `@hexaijs/postgres` |
|----------|-------------------|---------------------|
| Transaction start | `BEGIN` when the outermost scope opens | `BEGIN` at the first query |
| A joining scope fails and the outer scope catches the error | Rolls back; the outer scope resolves with its result | Rolls back; the outer scope rejects with `TransactionAbortedError` unless `preventCommit()` was called |
| Database access inside hooks | `getClient()` throws; use the `Database` directly | `db` works in every hook |
| `scope()` opened from a `beforeCommit` hook | Rejects with SQLite's "cannot start a transaction within a transaction", because the transaction is still open; if the hook lets that error out, the transaction rolls back like any `beforeCommit` failure | Joins the transaction |
| Scopes running at the same time | Share one transaction per `Database` | A scope joins only the transaction of the scope it runs inside, tracked with `AsyncLocalStorage` |
| Propagation, isolation levels, `onEveryCommit()`, `CommitControl`, `TransactionResources` | Not available | Available |

## Usage

### Accessing the database in your code

Code that runs inside a scope, such as a repository called from a command
handler, gets the `Database` through `getClient()`:

```typescript
import { SqliteUnitOfWork } from "@hexaijs/sqlite";

class OrderRepository {
    constructor(private readonly unitOfWork: SqliteUnitOfWork) {}

    async updateStatus(id: string, status: string): Promise<void> {
        this.unitOfWork
            .getClient()
            .prepare("UPDATE orders SET status = ? WHERE id = ?")
            .run(status, id);
    }
}
```

`getClient()` throws `No transaction is active` when no scope is running.

### Test setup

Use the test helpers for fast, isolated integration tests:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { SqliteUnitOfWork } from "@hexaijs/sqlite";
import { getSqliteConnection } from "@hexaijs/sqlite/test";

describe("OrderRepository", () => {
    let db: Database;
    let unitOfWork: SqliteUnitOfWork;

    beforeEach(() => {
        // Create a fresh in-memory database
        db = getSqliteConnection();

        // Create the schema
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

`getSqliteConnection()` returns a new in-memory database. In-memory SQLite
databases live in RAM and disappear when the connection closes, so each test
starts from an empty database.

### SqliteRepositoryForTest

`SqliteRepositoryForTest` is a generic repository for test fixtures. It
implements the `Repository<E>` interface from `@hexaijs/core` and stores each
entity as JSON in a table named after its `namespace`.

```typescript
import { SqliteRepositoryForTest, getSqliteConnection } from "@hexaijs/sqlite/test";
import { Id, Identifiable } from "@hexaijs/core";

class OrderId extends Id<string> {}

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

// The serialized form of an order
interface OrderMemento {
    id: string;
    status: string;
}

const db = getSqliteConnection();
const orderRepository = new SqliteRepositoryForTest<Order, OrderMemento>(db, {
    namespace: "orders",
    hydrate: (m) => new Order(new OrderId(m.id), m.status),
    dehydrate: (e) => ({ id: e.getId().getValue(), status: e.getStatus() }),
});

await orderRepository.add(new Order(new OrderId("order-1"), "pending"));
const order = await orderRepository.get(new OrderId("order-1"));
await orderRepository.update(order);
const count = await orderRepository.count();
```

The repository creates its table on first use. `get()` and `update()` throw
`ObjectNotFoundError` for an unknown id, and `add()` throws
`DuplicateObjectError` for an id that already exists.

### File-based database

To keep data across test runs, or to inspect it while debugging, pass a file
name:

```typescript
import { getSqliteConnection } from "@hexaijs/sqlite/test";

// File-based database instead of in-memory
const db = getSqliteConnection("./test-database.sqlite");
```

### Deprecated: wrap()

`wrap(fn)` is deprecated since 0.3.0; use `scope()`. It behaves the same as
`scope()` (in fact `scope()` calls it) and also passes the `Database` to `fn`.

## API reference

| Export | Description |
|--------|-------------|
| `SqliteUnitOfWork` | Transaction management implementing `UnitOfWork<Database>`, with lifecycle hooks |

**From `@hexaijs/sqlite/test`:**

| Export | Description |
|--------|-------------|
| `getSqliteConnection` | Creates a SQLite connection (in-memory by default) |
| `SqliteRepositoryForTest` | Generic repository for test fixtures |

## See Also

- [@hexaijs/core](../core/README.md) - Core interfaces (`UnitOfWork`, `Repository`)
- [@hexaijs/postgres](../postgres/README.md) - PostgreSQL unit of work, event store and projections for production
- [@hexaijs/application](../application/README.md) - Applications, handlers and the application context through which your handlers reach a unit of work
