# @hexaijs/postgres

> PostgreSQL unit of work, event store, projections and migrations for hexai

`@hexaijs/postgres` implements the infrastructure contracts of
[`@hexaijs/core`](../core/README.md) on PostgreSQL with
[`pg`](https://node-postgres.com/). At its center is a unit of work: the object
that runs your queries in one transaction per scope and commits or rolls back
when the scope ends. Around it, the package provides an event store for domain
events, a projection engine that builds read models from those events, a
migration runner, connection configuration and test helpers. Use it when your
hexai application keeps its state in PostgreSQL.

## Contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Concepts](#concepts): unit of work and scope, queries through `db`,
  propagation, lifecycle hooks
- [Using the unit of work](#using-the-unit-of-work): creating one, isolation
  levels, `CommitControl`, `TransactionResources`, finalization and work in
  flight, deprecated client access
- [Event store](#event-store)
- [Projections](#projections)
- [Migrations](#migrations)
- [Configuration](#configuration)
- [Database utilities](#database-utilities)
- [Testing](#testing)
- [API reference](#api-reference)
- [Migration guide](#migration-guide)

## Installation

```bash
npm install @hexaijs/postgres @hexaijs/core ezcfg pg
```

| Peer dependency | Used for |
|-----------------|----------|
| `@hexaijs/core` | Core contracts such as `UnitOfWork`, `Propagation`, `EventStore` and `Message` |
| `ezcfg` | `PostgresConfig` and `postgresConfig()`, which this package re-exports |
| `pg` | The PostgreSQL driver |

The supported version ranges are the `peerDependencies` in this package's
`package.json`.

## Quick start

```typescript
import * as pg from "pg";
import { createPostgresUnitOfWork } from "@hexaijs/postgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const unitOfWork = createPostgresUnitOfWork(pool);

// Both inserts commit together, or neither does.
await unitOfWork.scope(async () => {
    await unitOfWork.db.query(
        "INSERT INTO orders (id, status) VALUES ($1, $2)",
        ["order-1", "pending"]
    );
    await unitOfWork.db.query(
        "INSERT INTO order_items (order_id, product_id) VALUES ($1, $2)",
        ["order-1", "product-1"]
    );
});

// Outside any scope, a query runs on its own, like pool.query().
const { rows } = await unitOfWork.db.query(
    "SELECT * FROM orders WHERE id = $1",
    ["order-1"]
);
```

`scope()` commits when its callback resolves and rolls back when it rejects.
The [Concepts](#concepts) section explains what a scope is and where each query
goes.

## Concepts

### Unit of work, scope and transaction

A unit of work is the object that owns your transactions. You create one with
`createPostgresUnitOfWork()` and keep it for the life of the process.
`PostgresUnitOfWork` is its interface, and `DefaultPostgresUnitOfWork` is the
implementation.

A scope is one call of `unitOfWork.scope(fn)`. In the common case, the scope
that creates a transaction commits it when `fn` resolves and rolls it back when
`fn` rejects, then settles with `fn`'s result or error; the sections below
cover the exceptions. The unit of work tracks the current transaction with
`AsyncLocalStorage`, so every query made while `fn` runs, including in the
functions it awaits, belongs to that transaction without passing a client
around.

Your code decides where scopes begin and end. An application built with
`ApplicationBuilder` from [`@hexaijs/application`](../application/README.md)
runs its handlers without opening a scope; in that package, only
`SimpleCompositeApplication.handleEvent()` opens one. Open the scope where the
command's work runs, usually inside the command handler, as
[Wiring the Unit of Work and Event Publishing](../application/README.md#wiring-the-unit-of-work-and-event-publishing)
shows. If you open it outside the handler instead, around
`application.executeCommand()` or in a command interceptor, that call resolves
to an `ErrorResult` instead of rejecting when the handler fails, so the scope
would commit the failed command's writes: call `preventCommit()` on an error
result (see [CommitControl](#commitcontrol)), or turn it into a rejection
inside the scope.

`scope()` does **not** send `BEGIN` right away. The transaction starts at the
first query. A scope that ends without a query acquires no connection at all:

```typescript
await unitOfWork.scope(async () => {
    // No BEGIN yet: the transaction has not started.

    if (!needsUpdate) return; // Early exit: no connection acquired

    // BEGIN is sent here, before the first query.
    await unitOfWork.db.query("UPDATE orders SET status = $1 WHERE id = $2", ["confirmed", orderId]);
    // COMMIT is sent when the callback returns.
});
```

The `PostgresUnitOfWork` interface extends the base `UnitOfWork` transaction
boundary of `@hexaijs/core`, the core `UnitOfWorkClientAccess` capability
without its deprecated `wrap()`, and `TransactionLifecycle` (the lifecycle
hooks). It adds
the Postgres-only `onEveryCommit()` observer API (`PostgresUnitOfWorkObserver`).
`DefaultPostgresUnitOfWork` also implements the Postgres-only capabilities
[`CommitControl`](#commitcontrol) and
[`TransactionResources`](#transactionresources).

### Queries through `db`

Send queries through `unitOfWork.db`. `db` is always the same object, so a
repository can take it once and keep it. Each query goes to the transaction
that is current when it is called:

```typescript
import type { PostgresQueryable } from "@hexaijs/postgres";

class OrderRepository {
    constructor(private readonly db: PostgresQueryable) {}

    async updateStatus(id: string, status: string): Promise<void> {
        await this.db.query("UPDATE orders SET status = $1 WHERE id = $2", [status, id]);
    }
}

const orders = new OrderRepository(unitOfWork.db);

await unitOfWork.scope(async () => {
    await orders.updateStatus(orderId, "confirmed"); // runs in this scope's transaction
});
```

`PostgresQueryable` has only `query()`. pg's `Client`, `PoolClient` and `Pool`
fit it as well, so such a repository also runs against a plain pool, for
example in a script.

`db.query()` sends exactly one statement per call. Pass values as parameters
(`$1`, `$2`, ...); a call with two statements rejects with a syntax error
(SQLSTATE `42601`). The values are copied when `query()` is called, so changing
the array afterwards does not change the query.

Where a query goes depends on where it is called:

| Where `db.query()` is called | What happens |
|------------------------------|--------------|
| Outside any scope | Borrows a connection for the query and returns it, or destroys it when the query fails; the query commits on its own |
| Inside a scope | Runs in the scope's transaction, in order with the transaction's other statements |
| In work the scope did not await, after the scope's outcome is decided | Rejects with `TransactionClosedError` (see [Finalization and work in flight](#finalization-and-work-in-flight)) |

#### Queries without a transaction

Outside any scope, `db.query()` borrows a connection for that one query and
returns it right after, as `pool.query()` does. The query commits on its own.
When the query fails, the connection is destroyed instead of returned, as
`pool.query()` also does, since it may still be busy with the failed query
(for example after pg's `query_timeout`). This suits reads, which need no
transaction:

```typescript
const result = await unitOfWork.db.query("SELECT * FROM users WHERE id = $1", [userId]);
const user = result.rows[0];
```

Outside a scope, keep in mind:

- Consecutive queries may run on different connections. Session state such as
  `SET search_path`, temporary tables or session-level advisory locks does not
  carry over; open a scope when it must.
- Several writes commit one by one. Open a scope when they must succeed or fail
  together.
- Queries made at the same time borrow a connection each.
- A unit of work created from a connection string or `PostgresConfig` opens and
  closes a new connection for each such query. Prefer a pool.

| Method | Transaction | Connection | Use case |
|--------|-------------|------------|----------|
| `scope()` | Yes, from the first query | Acquired at the first query | Commands (recommended) |
| `db.query()` outside a scope | No | One per query | Reads (`SELECT`) |

### Propagation: joining, nesting and new transactions

A scope opened inside another scope joins the current transaction by default.
Choose another behavior with the `propagation` option and `Propagation` from
`@hexaijs/core`:

```typescript
import { Propagation } from "@hexaijs/core";

// EXISTING (default): join the current transaction, or create one if none exists
await unitOfWork.scope(async () => {
    await unitOfWork.scope(async () => {
        // Same transaction as the outer scope
    }, { propagation: Propagation.EXISTING });
});

// NEW: always start a new transaction
await unitOfWork.scope(async () => {
    await unitOfWork.scope(async () => {
        // Independent transaction on a separate connection
    }, { propagation: Propagation.NEW });
});

// NESTED: run in a savepoint of the current transaction
await unitOfWork.scope(async () => {
    try {
        await unitOfWork.scope(async () => {
            throw new Error("Roll back this part only");
        }, { propagation: Propagation.NESTED });
    } catch {
        // The savepoint rolled back; the outer transaction continues
    }
});
```

Only the scope that creates a transaction finalizes it. A scope that joins with
`EXISTING` or `NESTED` takes part in the transaction, and nothing is committed
when its callback returns. The creating scope settles after `COMMIT` or
`ROLLBACK`, the client cleanup and the after hooks have run. It does not wait
for joined work it did not await (see
[Finalization and work in flight](#finalization-and-work-in-flight)).

If a joining `EXISTING` scope fails, the transaction is aborted even when the
outer scope catches the error (see [CommitControl](#commitcontrol)).

Savepoints form a stack on one connection, so a `NESTED` scope can open inside
another `NESTED` scope but not beside one. Opening a `NESTED` scope while a
sibling `NESTED` scope of the same transaction is still running rejects with
`UnsupportedNestedTransactionCapabilityError`; run sibling savepoints one after
the other.

A `Propagation.NEW` scope needs a connection of its own. A scope that holds a
pooled client and awaits one can wait forever when every client of the pool is
held that way. Size the pool for the connections one request holds at once, or
set `connectionTimeoutMillis` so the wait fails instead.

### Transaction lifecycle hooks

Register callbacks that run at fixed points of the transaction:

```typescript
await unitOfWork.scope(async () => {
    // Validate before committing
    unitOfWork.beforeCommit(async () => {
        const result = await unitOfWork.db.query("SELECT count(*) FROM order_items WHERE order_id = $1", [orderId]);
        if (parseInt(result.rows[0].count) === 0) throw new Error("Order must have at least one item");
    });

    // Flush buffered work after validation, still inside this transaction
    unitOfWork.beforeCommit(async () => {
        await unitOfWork.db.query("INSERT INTO order_audit_log (order_id) VALUES ($1)", [orderId]);
    }, { phase: "drain" });

    // Send a notification after a successful commit
    unitOfWork.afterCommit(async () => {
        await notificationService.send("Order confirmed");
    });

    // Clean up on failure
    unitOfWork.afterRollback(async () => {
        await fileStorage.deleteUploadedFiles(orderId);
    });

    await unitOfWork.db.query("UPDATE orders SET status = $1 WHERE id = $2", ["confirmed", orderId]);
});
```

**Key behaviors:**

- `beforeCommit` hooks run **before** `COMMIT`. If any hook throws, the
  transaction rolls back instead.
- `beforeCommit` drain hooks (`{ phase: "drain" }`) run after the ordinary
  `beforeCommit` hooks, still inside the same transaction.
- A `scope()` opened from a `beforeCommit` hook joins the transaction. If it
  fails before the hooks have finished, or a hook calls `preventCommit()`, the
  transaction rolls back instead of committing.
- `afterRollback` hooks also run when the `ROLLBACK` statement fails. No after
  hook runs when `COMMIT` fails, because its outcome is unknown.
- `afterCommit` and `afterRollback` hooks run after the transaction is
  finalized and outside the completed transaction context.
- `afterCommit` and `afterRollback` hooks run **best-effort**: all hooks run
  even if some fail. The scope then rejects with an `AggregateError` of the
  failures, whose `cause` is the error that caused the rollback, if any. The
  transaction's outcome stands.
- Use `db` for follow-up database work in `afterCommit` or `afterRollback`;
  outside the completed transaction, each query runs on its own. `getClient()`
  is not available there.
- Hooks are **scope-local**: registered within a `scope()`, cleared after the
  transaction completes.
- Hooks registered inside `Propagation.NESTED` scopes are attached to the
  current root transaction and run when that root transaction finalizes.
- Calling a hook registration method outside a `scope()` throws an error.

#### onEveryCommit()

`onEveryCommit()` is a Postgres-only observer API. It is not part of the core
`UnitOfWork` or `TransactionLifecycle` contracts.

```typescript
const unsubscribe = unitOfWork.onEveryCommit(async () => {
    await projectionWakeQueue.wake();
});

// Later, when the observer is no longer needed:
unsubscribe();
```

Observers belong to the unit of work instance and may be registered outside a
scope. They run after a root `COMMIT` succeeds, after the transaction's
`afterCommit` hooks, and outside the completed transaction context. Use `db` if
an observer needs follow-up database work.

Avoid opening a committing `scope()` on the same unit of work from an
`onEveryCommit()` observer: that commit would notify the same observer again.
Use `db` for follow-up database work, or register a separate post-commit
coordinator when more transaction boundaries are needed.

Observer failures are logged and do not change the result of the completed
scope. Observers do not run for rollbacks, for a `COMMIT` that PostgreSQL
answers with `ROLLBACK`, for the release of a `Propagation.NESTED` savepoint,
or for scopes that never started a transaction.

## Using the unit of work

### Creating a unit of work

`createPostgresUnitOfWork()` accepts a pool, a connection string or a
`PostgresConfig`:

```typescript
import * as pg from "pg";
import { PostgresConfig, createPostgresUnitOfWork } from "@hexaijs/postgres";

// From a connection pool (recommended for production)
const pool = new pg.Pool({ connectionString: "postgres://user:pass@localhost:5432/mydb" });
const pooled = createPostgresUnitOfWork(pool);

// From a connection string
const fromUrl = createPostgresUnitOfWork("postgres://user:pass@localhost:5432/mydb");

// From PostgresConfig (reads DB_URL)
const fromConfig = createPostgresUnitOfWork(PostgresConfig.fromEnv("DB"));
```

| Source | Connection for each transaction | After the transaction |
|--------|---------------------------------|-----------------------|
| `pg.Pool` | `pool.connect()` | Released to the pool, or destroyed when a failure left it in an unknown state (for example a failed `ROLLBACK`) |
| Connection string or `PostgresConfig` | A new `pg.Client` | `client.end()` |

Only the pool form reuses connections. The other forms open a new connection
for every transaction and every query outside a scope; pool settings in a
`PostgresConfig`, such as `withPoolSize()`, do not create a pool.

For other ways to obtain connections, construct `DefaultPostgresUnitOfWork`
with a client factory and an optional cleanup:

```typescript
import * as pg from "pg";
import { DefaultPostgresUnitOfWork } from "@hexaijs/postgres";

const unitOfWork = new DefaultPostgresUnitOfWork(
    () => new pg.Client({ connectionString: "postgres://..." }),
    (client) => (client as pg.Client).end()
);
```

The client factory (`ClientFactory`) returns a client, or a promise of one, for
each transaction and for each query outside a scope. It may return a client
that is not connected yet; the unit of work connects it. The cleanup
(`ClientCleanUp`) receives the client typed as `pg.ClientBase`, which declares
no `end()`, hence the cast. It runs after the transaction completes (commit or
rollback), exactly once per client, including a client whose transaction
failed to start. When the cleanup fails after a transaction, the failure is
logged with `console.error` and does not change the scope's result.

### Isolation levels

Set the isolation level of a transaction when stricter guarantees are needed:

```typescript
import { IsolationLevel } from "@hexaijs/postgres";

await unitOfWork.scope(async () => {
    // Serializable isolation prevents phantom reads
    const result = await unitOfWork.db.query("SELECT * FROM inventory WHERE product_id = $1", [productId]);
    // ...
}, { isolationLevel: IsolationLevel.SERIALIZABLE });
```

The isolation level comes from the scope that creates the transaction. A joining
scope that names a different `isolationLevel` rejects with
`IncompatibleIsolationLevelError` without running its callback; omit the option
when joining, or use `Propagation.NEW` for work that needs its own isolation
level.

Available levels:

- `IsolationLevel.READ_UNCOMMITTED`
- `IsolationLevel.READ_COMMITTED` (PostgreSQL default)
- `IsolationLevel.REPEATABLE_READ`
- `IsolationLevel.SERIALIZABLE`

### CommitControl

`CommitControl` rolls a transaction back while the scope still returns the
callback's value. Use it with value-based error contracts, which return an
error result instead of throwing. `application.executeCommand()` from
`@hexaijs/application` is one: it resolves to an `ErrorResult` when a handler
fails. A scope opened inside the command handler needs none of this, because
the handler's error rejects the scope. A scope opened around
`executeCommand()`, as below, would commit the failed command's writes unless
you prevent the commit:

```typescript
import type { Application, Command } from "@hexaijs/application";
import { createPostgresUnitOfWork } from "@hexaijs/postgres";

const unitOfWork = createPostgresUnitOfWork(pool);

async function executeInTransaction(application: Application, command: Command) {
    return unitOfWork.scope(async () => {
        const result = await application.executeCommand(command);

        if (result.isError) {
            unitOfWork.preventCommit(result.error);
        }

        return result;
    });
}
```

`preventCommit()` marks the root transaction as non-committable. The scope still
returns normally, but the transaction rolls back during finalization.
`isCommitPrevented()` tells whether that has happened.

If an `EXISTING` nested scope throws and the root scope catches that error, the
root scope must either rethrow or call `preventCommit()`. Otherwise,
`DefaultPostgresUnitOfWork` rejects root finalization with
`TransactionAbortedError` to prevent accidentally committing a transaction that
was already aborted. The same applies when the root scope catches a failed
transaction start (`BEGIN` or `SET TRANSACTION`) from its first query.

`CommitControl` is not available inside the callback of a `Propagation.NESTED`
scope, because savepoints do not own the root transaction's outcome. Code
outside the savepoint, such as the root scope's own callback, can still use it
while a `NESTED` scope runs.

`createPostgresUnitOfWork()` returns a `DefaultPostgresUnitOfWork`, which
implements `CommitControl`, as does `PostgresUnitOfWorkForTesting`. Code that
receives a unit of work can ask for the capability in its parameter type, for
example `PostgresUnitOfWork & CommitControl`.

### TransactionResources

`TransactionResources` stores values that live as long as the current
transaction, without threading them through every call. Resources are cleared
when the transaction commits or rolls back.

```typescript
import { DomainEvent } from "@hexaijs/core";
import { createTransactionResourceKey } from "@hexaijs/postgres";

const eventsKey = createTransactionResourceKey<DomainEvent[]>(
    "buffered-domain-events"
);

await unitOfWork.scope(async () => {
    const events = unitOfWork.getOrCreateTransactionResource(
        eventsKey,
        () => []
    );

    events.push(...aggregate.flushEvents());
});
```

The capability also has `getTransactionResource(key)` and
`setTransactionResource(key, value)`. Transaction resources belong to the root
transaction and are not available inside the callback of a
`Propagation.NESTED` scope. `DefaultPostgresUnitOfWork` and
`PostgresUnitOfWorkForTesting` implement `TransactionResources`.

`TransactionResourceAware` remains available as a deprecated alias for
backward compatibility. Prefer `TransactionResources` in new code.

### Finalization and work in flight

This section explains how a transaction orders its statements and what happens
to work that is still running when the transaction ends.

#### The statement line

A transaction sends its statements to its connection one at a time, in the
order they were made, in one line with `BEGIN`, the savepoint statements and
the final `COMMIT` or `ROLLBACK`. This holds for queries through `db` and for
queries through a client the transaction handed out. A failed query does not
hold up the ones behind it.

pg's `query_timeout` counts only from a query's turn. The transaction hands a
query to pg when the statements before it have finished, and pg starts the
timer then, so time spent waiting in the line does not use up the timeout.

#### The guarded client

Inside a transaction, the deprecated `withClient()` and `getClient()` give you
a client that the transaction guards. It is a proxy of the client the factory
or pool provided, so `instanceof`, events and its other members behave as
usual, with two differences:

- Its queries go through the transaction's statement line. A query in callback
  form takes the same way and reports its result through the callback.
- `release()`, `end()` and `connect()` throw, because the unit of work returns
  the client when the transaction ends. `ensureConnection()` fails on it for
  the same reason.

#### When the outcome is decided

When the creating scope's callback ends, the transaction decides its outcome at
once. It does not wait for work that is still running, such as a joining scope
or a query the scope did not await.

- Queries that got in before the decision are sent first and are committed or
  rolled back with the transaction. The final statement follows them, and only
  then does the client go back to the pool, so nothing reaches the connection
  after it has been returned.
- After the decision, queries through `db` and through a client the transaction
  handed out reject with `TransactionClosedError`. So do `withClient()`,
  `scope()`, `getClient()`, hook registration, `preventCommit()` and
  transaction resources in the transaction's context. Work that is still
  running settles with its own result; a joining scope that queries again
  rejects with `TransactionClosedError`.
- While `beforeCommit` hooks run, only work started from those hooks is
  accepted, including work a hook did not await, until the outcome is decided
  after the hooks.
- A rejection that nobody awaits still surfaces as an unhandled rejection; the
  unit of work does not attach handlers to the promises it returns.

Await the work you start inside a scope, so that all of it belongs to the
transaction.

#### Cursors and other submittable queries

A submittable query, such as a cursor from `pg-cursor`, takes its turn in the
same line. The client returns it at once and sends it when the queries before
it have finished, right away when none are running. The statements behind it,
the final `COMMIT` or `ROLLBACK` included, wait until it is done, so finish or
close it before the scope ends. As with pg's own queue, closing a cursor that
is still waiting behind other queries does nothing, so await those queries
first.

#### Event listeners

Event listeners added through the client are added to the client itself and
stay on it after it returns to the pool. pg calls them with that client as
`this`, which the transaction does not guard, so remove them before the scope
ends and do not query through `this` in them.

#### When rollback or cleanup fails

When the scope's callback or a `beforeCommit` hook fails, the scope rejects
with that error even if the following `ROLLBACK` or the client cleanup fails as
well. Those secondary failures are logged with `console.error`, and a client
whose `ROLLBACK` failed is destroyed instead of being returned to the pool. A
`NESTED` scope whose callback failed likewise rejects with that failure when
`ROLLBACK TO SAVEPOINT` fails or is refused, and the savepoint failure is
logged.

A `COMMIT` failure rejects the scope with the `COMMIT` error. When PostgreSQL
answers `COMMIT` with `ROLLBACK` because a statement had already failed inside
the transaction, even one nobody awaited, the scope rejects with
`TransactionAbortedError`.

### Direct client access (deprecated)

`withClient()` and `getClient()` are deprecated and will be removed in the next
major version. Use `db` for queries. Work that needs the pg client itself, such
as `COPY`, can keep using `withClient()` for now; its replacement will be
decided before `withClient()` is removed.

`withClient(fn)` runs `fn` with a client. Inside a scope, it is a client the
transaction guards (see [The guarded client](#the-guarded-client)), and its
queries share the transaction with `db`. Outside any scope, it is a new
connection from the factory, cleaned up after `fn` the same way whether `fn`
succeeds or fails.

`getClient()` returns the guarded client of the current transaction. It throws
outside a scope, and inside a scope until a query has started the transaction.

## Event store

### Storing and reading events

`PostgresEventStore` implements `EventStore` from `@hexaijs/core`: it appends
domain events to a table and reads them back in order. Each stored event gets a
`position`, a number that increases with every append. The event store takes a
`PostgresUnitOfWork` and queries through its `db`, so inside a `scope()` it
works in the scope's transaction. Outside any scope, `store()` and `storeAll()`
open a transaction of their own.

Run [`runHexaiMigrations()`](#built-in-migrations) first. It creates the event
table `hexai__events` and its position counter table
`hexai__event_position_counter`.

```typescript
import { PostgresEventStore } from "@hexaijs/postgres";
import { DomainEvent } from "@hexaijs/core";

class OrderPlaced extends DomainEvent<{ orderId: string; customerId: string }> {
    static readonly type = "order.order-placed";
}

const eventStore = new PostgresEventStore(unitOfWork);

// Store one event
const stored = await eventStore.store(new OrderPlaced({
    orderId: "order-123",
    customerId: "customer-456"
}));
console.log(stored.position); // Position of the event in the store

// Store several events atomically
const storedEvents = await eventStore.storeAll([event1, event2, event3]);

// Fetch events for replay or projections
const { events, lastPosition } = await eventStore.fetch(0, 100);
// events: StoredEvent[], the events after position 0, at most 100
// lastPosition: the highest position in the store (for catch-up detection)
```

Inside a scope, the event store shares the scope's transaction with your
repositories:

```typescript
await unitOfWork.scope(async () => {
    await repository.save(aggregate);
    await eventStore.storeAll(aggregate.getEventsOccurred());
    // Both commit or roll back together
});
```

| Method | Returns |
|--------|---------|
| `store(event)` | The `StoredEvent` with its position |
| `storeAll(events)` | The `StoredEvent`s, in order, appended in one insert |
| `fetch(afterPosition, limit?)` | `{ events, lastPosition }`: the events after `afterPosition`, and the highest position in the store |
| `stream(afterPosition, batchSize)` | An `AsyncGenerator` of the events after `afterPosition` |
| `getEventCount(afterPosition)` | The number of events after `afterPosition` |
| `getLastPosition()` | The highest position in the store, or `0` |

Fetched events come back as `Message` instances built from the stored payload
and headers.

### Streaming events

Use `stream()` to process many events, for example to rebuild a projection. It
returns an `AsyncGenerator` that fetches events in batches:

```typescript
for await (const event of eventStore.stream(0, 500)) {
    await projector.apply(event);
}
```

The stream prefetches the next batch while it yields the current one, hiding
database latency behind event processing. Stopping early (for example with
`break`) is safe: the pending prefetch is handled.

### How positions are allocated

Event positions come from a counter row that the appending transaction locks,
not from a PostgreSQL sequence. This keeps positions safe for projection
checkpoints: a transaction holding a lower position must commit or roll back
before a higher position can be assigned. The trade-off is that concurrent
appends wait for each other at position allocation until the appending
transaction finishes.

When you append inside a larger scope, append near the end of the transaction,
so the counter row lock is not held while unrelated work is still running.

### Custom table names

```typescript
const eventStore = new PostgresEventStore(unitOfWork, {
    tableName: "my_bounded_context_events"
});
```

A custom event table needs a matching position counter table. For a custom
`tableName`, the counter table is `<tableName>_position_counter` unless you set
`positionCounterTableName`. Create and seed the counter table before writing
events:

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

```typescript
const eventStore = new PostgresEventStore(unitOfWork, {
    tableName: "my_bounded_context_events",
    positionCounterTableName: "my_bounded_context_event_positions"
});
```

For an existing custom event table, seed `last_position` from
`COALESCE(MAX(position), 0)` instead of `0`, and keep it at least that high
before legacy writes resume after a migration window. If that table used a
sequence-backed `position` default, drop the default after the counter is seeded
so future writes must use the counter-allocated position.

### Upgrading an existing event table

The built-in migration that introduces the counter removes the old `position`
column default. Use a write-stop deployment order: stop old writers, run
`runHexaiMigrations()`, then start new writers. Old writers fail after the
migration because they omit `position`; new writers fail before the migration
because the counter table does not exist yet. The migration briefly takes an
`ACCESS EXCLUSIVE` lock on the event table, so long-running readers can delay
it; consider setting database-level `lock_timeout` and `statement_timeout` for
production migration runs.

Runtime appends do not seed the position counter from existing rows. For any
existing legacy or custom event table, seed or sync the counter to at least
`COALESCE(MAX(position), 0)` before starting new writers and before legacy
writes resume after a migration window.

### Transactional event store sink

`PostgresTransactionalEventStoreSink` buffers published events in the current
Postgres transaction and appends them during the `beforeCommit` drain phase,
through the transaction's own client.

`attachPostgresEventStoreSink()` creates a sink and subscribes it to an event
publisher. The publisher's other subscribers, such as your application's event
handlers, still run immediately; only the event-store write waits for the drain.

The sink is a Postgres package concept, not a core interface. The helper only
requires the publisher to implement the core
`SubscribableEventPublisher<Message>` contract; transaction buffering, resource
storage and drain-phase flushing stay inside `@hexaijs/postgres`.

```typescript
import {
    attachPostgresEventStoreSink,
    createPostgresUnitOfWork,
} from "@hexaijs/postgres";
import { ApplicationEventPublisher } from "@hexaijs/application";

const commandUnitOfWork = createPostgresUnitOfWork(pool);
const publisher = new ApplicationEventPublisher();

const detachEventStoreSink = attachPostgresEventStoreSink(
    publisher,
    commandUnitOfWork,
    {
        onStored: async (storedEvents) => {
            trackStoredEventPositions(storedEvents);
        },
    }
);

await commandUnitOfWork.scope(async () => {
    await repository.save(order);
    await publisher.publish(...order.flushEvents());
});
```

The unit of work must implement [`TransactionResources`](#transactionresources)
(`DefaultPostgresUnitOfWork` and `PostgresUnitOfWorkForTesting` do). The third
argument also accepts `tableName` and `positionCounterTableName`, as
`PostgresEventStore` does.

**Key behaviors:**

- Events must be accepted inside a `unitOfWork.scope()`. Publishing outside a
  transaction fails instead of writing in autocommit mode.
- Accepted events are buffered before awaiting transaction startup, so accept
  order is preserved even when the first event needs to start a lazy
  transaction.
- The first buffered event starts the transaction so that commit hooks are
  guaranteed to run, but event positions are not allocated until the drain
  phase.
- Events published by main-phase `beforeCommit` hooks are included in the same
  drain. Events accepted while draining are appended in a later drain batch.
- `onStored(storedEvents)` runs after each drain batch is appended and before
  the surrounding transaction commits. If it throws or rejects, the drain hook
  fails and the transaction rolls back.
- `onStored` is for capturing stored positions, not for confirming that a
  projection has applied those events. Wake external projection workers after
  commit, for example from `onEveryCommit()` or an `afterCommit()` hook.
- Events accepted after the sink has drained fail with
  `TransactionalEventStoreSinkClosedError`, causing a rollback instead of
  silent event loss.
- `Propagation.NESTED` savepoints are not supported, because transaction
  resources belong to the root transaction.

Only the event-store write is delayed. Other subscribers still run immediately,
so external side effects such as email, HTTP calls or non-transactional
read-model updates are not made atomic by this buffer.

## Projections

A projection turns the event stream into a read model: a table shaped for
queries, kept up to date as events are appended. `@hexaijs/postgres/projection`
provides a projection engine for read models built from `PostgresEventStore`.
It lives in a subpath so the root `@hexaijs/postgres` entry point stays focused
on transactions, the event store and migrations.

Run the projection checkpoint migration before starting projection workers:

```typescript
import { runProjectionMigrations } from "@hexaijs/postgres/projection";

await runProjectionMigrations("postgres://user:pass@localhost:5432/mydb");
```

Define a read model with selectors. `@When` is a legacy TypeScript decorator,
so enable `experimentalDecorators` in your `tsconfig.json`:

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
            `INSERT INTO read_order_summary (order_id, position)
             VALUES ($1, $2)
             ON CONFLICT (order_id) DO UPDATE SET position = $2`,
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

To wake the engine after every commit instead, register
`unitOfWork.onEveryCommit(() => wakeQueue.wake())` once.

What the engine guarantees, in short:

- When a read model's `version` changes, the engine resets that projection and
  rebuilds it from the event stream.
- A failed live event is an ordering barrier: the projection does not advance
  past it until it succeeds or the projection is isolated.
- Processing is effectively-once. The read model write and the projection
  checkpoint commit in one transaction, and that transaction skips events the
  committed checkpoint already covers. This holds only when `apply()` writes
  through the `client` it receives; keep `apply()` idempotent anyway (prefer
  upserts or `ON CONFLICT`).
- Each apply runs in its own transaction (`Propagation.NEW`), so it is safe to
  trigger `poll()` from an `afterCommit` hook without entangling projection
  writes with your command transaction.
- The engine targets a single owning process: exactly one process runs
  projections for a database. Registering the same read model name twice on
  one engine fails. Multi-process ownership (lease, fencing, checkpoint
  compare-and-swap) is not provided yet.

See [`docs/projection.md`](./docs/projection.md) for the projection
architecture, delivery semantics, failure handling, rebuilds and engine
options.

## Migrations

### Running migrations

`runMigrations()` applies the migrations in a directory and records each one in
a ledger table. It supports two formats, chosen by the directory's contents:
when any subdirectory contains a `migration.sql` file, the directory holds SQL
migrations; otherwise it holds JavaScript migrations for
[`node-pg-migrate`](https://salsita.github.io/node-pg-migrate/).

```typescript
import { PostgresConfig, runMigrations } from "@hexaijs/postgres";

// JavaScript migrations (node-pg-migrate format)
await runMigrations({
    url: "postgres://user:pass@localhost:5432/mydb",
    dir: "./migrations",
});

// With a namespace (uses its own ledger table)
await runMigrations({
    url: "postgres://user:pass@localhost:5432/mydb",
    dir: "./migrations/orders",
    namespace: "orders", // Ledger table: hexai__migrations_orders
});

// SQL migrations (directories with migration.sql files)
// migrations/
//   001_create_orders/
//     migration.sql
//   002_add_status/
//     migration.sql
await runMigrations({
    url: PostgresConfig.fromEnv("DB"),
    dir: "./migrations",
});
```

| Option | Default | Description |
|--------|---------|-------------|
| `url` | (required) | Connection string or `PostgresConfig` of the database to migrate |
| `dir` | (required) | Directory that holds the migrations |
| `namespace` | none | Ledger table `hexai__migrations_<namespace>` instead of `hexai__migrations` |
| `direction` | `"up"` | `"up"` or `"down"`; JavaScript migrations only |
| `count` | all pending | How many migrations to run; JavaScript migrations only |
| `dryRun` | `false` | Print the pending migrations without applying them |

JavaScript migrations run through `node-pg-migrate` with all pending migrations
in one transaction.

### SQL migrations

The runner applies SQL migrations in the order of the numeric prefix of their
directory names, and only upward. It runs one pending migration per
transaction: it executes `migration.sql` and records the ledger row in the same
transaction, so a crash before commit rolls both back. Runners that use the
same namespace take turns through an advisory lock keyed by the ledger table;
different namespaces use different ledger tables and progress independently.

SQL migration files must be safe to run inside a PostgreSQL transaction. Do not
include transaction-control statements (`BEGIN`, `COMMIT`, `ROLLBACK`) or
commands PostgreSQL disallows in transaction blocks, such as
`CREATE INDEX CONCURRENTLY` or `VACUUM`. The runner adds a unique index on
ledger `name` values and fails fast if an existing ledger already contains
duplicate migration names.

For SQL migrations, `dryRun: true` is read-only: it reads the existing ledger if
present and prints the pending migrations without creating or altering ledger
tables, indexes or application schema.

### Built-in migrations

`runHexaiMigrations()` creates the event store tables (`hexai__events` and
`hexai__event_position_counter`) and records them under the `hexai` namespace.
`runProjectionMigrations()` from `@hexaijs/postgres/projection` creates the
projection checkpoint table under the `projection` namespace. Both accept a
connection string or a `PostgresConfig`.

```typescript
import { runHexaiMigrations } from "@hexaijs/postgres";

await runHexaiMigrations("postgres://user:pass@localhost:5432/mydb");
```

See [Upgrading an existing event table](#upgrading-an-existing-event-table)
before running them against an event table created by an older version.

## Configuration

`PostgresConfig` holds connection settings and never changes after it is
created. `@hexaijs/postgres` re-exports it from `ezcfg/postgres`.

```typescript
import * as pg from "pg";
import { PostgresConfig } from "@hexaijs/postgres";

// From a connection URL
const config = PostgresConfig.fromUrl("postgres://user:pass@localhost:5432/mydb");

// From environment variables
// URL mode: reads MY_DB_URL
const fromUrlEnv = PostgresConfig.fromEnv("MY_DB");

// Fields mode: reads MY_DB_HOST, MY_DB_PORT, MY_DB_DATABASE, MY_DB_USER, MY_DB_PASSWORD
const fromFieldsEnv = PostgresConfig.fromEnv("MY_DB", { mode: "fields" });

// The with* methods return a new instance
const testConfig = config
    .withDatabase("mydb_test")
    .withPoolSize(5);

// Use as a connection string
new pg.Client({ connectionString: config.toString() });
```

With `defineConfig` from `ezcfg`, already a peer dependency of this package:

```typescript
import { defineConfig } from "ezcfg";
import { postgresConfig } from "@hexaijs/postgres";

const getConfig = defineConfig({
    db: postgresConfig("ORDER_DB"),                       // reads ORDER_DB_URL
    readReplica: postgresConfig("REPLICA_DB", "fields"),  // reads individual fields
});

const config = getConfig();
config.db.host;        // "localhost"
config.db.toString();  // "postgres://..."
```

## Database utilities

Helper classes for managing databases and tables, mostly in tests:

```typescript
import * as pg from "pg";
import { DatabaseManager, TableManager, ensureConnection } from "@hexaijs/postgres";

// Create and drop databases
const dbManager = new DatabaseManager("postgres://user:pass@localhost:5432/postgres");
await dbManager.createDatabase("my_new_db");
await dbManager.dropDatabase("my_old_db");
await dbManager.close();

// Table operations
const client = new pg.Client({ connectionString: "postgres://user:pass@localhost:5432/mydb" });
const tableManager = new TableManager(client);
await tableManager.tableExists("orders");
await tableManager.truncateTable("orders");
await tableManager.dropAllTables();

// Connect a client unless it is already connected
await ensureConnection(client); // Safe to call multiple times
```

`DatabaseManager` and `TableManager` accept a connection string, a
`PostgresConfig` or a `pg.Client`, and connect on first use. `TableManager`
also has `getTableSchema()`, `createTable()`, `dropTable()` and
`truncateAllTables()`.

## Testing

### PostgresUnitOfWorkForTesting

`PostgresUnitOfWorkForTesting` is a `PostgresUnitOfWork` that runs inside a
transaction your test opens. Each test rolls that transaction back afterwards,
so the database stays clean without truncating tables.

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresUnitOfWorkForTesting } from "@hexaijs/postgres/test";
import { Client } from "pg";

describe("OrderService", () => {
    let client: Client;
    let uow: PostgresUnitOfWorkForTesting;

    beforeEach(async () => {
        client = new Client({ connectionString: "postgres://..." });
        await client.connect();
        await client.query("BEGIN"); // Start the external transaction
        uow = new PostgresUnitOfWorkForTesting(client);
    });

    afterEach(async () => {
        await client.query("ROLLBACK"); // Roll back all changes
        await client.end();
    });

    it("should create order", async () => {
        await uow.scope(async () => {
            await uow.db.query("INSERT INTO orders (id) VALUES ($1)", ["order-1"]);
        });

        // Verify within the same transaction
        const result = await client.query("SELECT * FROM orders");
        expect(result.rows).toHaveLength(1);
    });

    // After this test, ROLLBACK cleans up: no data persists
});
```

**How it works:**

| Operation | Production (`PostgresUnitOfWork`) | Testing (`PostgresUnitOfWorkForTesting`) |
|-----------|-----------------------------------|------------------------------------------|
| Start | `BEGIN` | `SAVEPOINT` |
| Commit | `COMMIT` | `RELEASE SAVEPOINT` |
| Rollback | `ROLLBACK` | `ROLLBACK TO SAVEPOINT` |

**Key behaviors:**

- **`db` and `withClient()`**: Use the test client directly, inside or outside
  a scope, always within the external transaction. Unlike
  `DefaultPostgresUnitOfWork`, they do not guard the client, and `db` sends one
  statement per call as in production.
- **Start**: The scope sends `SAVEPOINT` when it opens, not at its first query.
- **After hooks**: `afterCommit` and `afterRollback` run outside the completed
  scope. `getClient()` throws there, while `db` and `withClient()` still use
  the external test transaction client.
- **Abort propagation**: When a nested `EXISTING` scope rejects (with any
  value, `undefined` included, and even if caught), the whole transaction is
  marked as aborted and rolls back, as in production. When the root scope
  catches that rejection, it resolves with its callback's result, where
  production rejects with `TransactionAbortedError`.
- **NESTED savepoints**: `Propagation.NESTED` creates independent savepoints
  that can roll back without affecting the parent.
- **Propagation.NEW**: Logs a warning and creates a new savepoint instead,
  because a separate transaction is not possible inside the external
  transaction.
- **Isolation levels**: The `isolationLevel` option is ignored; the external
  transaction's level applies.
- **Single client**: Concurrent scope calls through `Promise.all` are not
  supported, because a single connection runs them.

```typescript
import { Propagation } from "@hexaijs/core";

// Abort propagation: rolls back like production
await uow.scope(async () => {
    await insertOrder(1);

    try {
        await uow.scope(async () => {
            throw new Error("fails");
        });
    } catch {
        // Caught, but the transaction is already marked as aborted
    }

    await insertOrder(2); // Runs, but will be rolled back
});
// Result: both orders rolled back, and the scope resolves

// NESTED savepoint: independent rollback
await uow.scope(async () => {
    await insertOrder(1);

    try {
        await uow.scope(async () => {
            await insertOrder(2);
            throw new Error("fails");
        }, { propagation: Propagation.NESTED });
    } catch {
        // Only the savepoint rolled back
    }

    await insertOrder(3);
});
// Result: orders 1 and 3 kept, order 2 rolled back
```

### createTestContext

`createTestContext(url)` from `@hexaijs/postgres/test` manages a throwaway test
database:

- `setup()` drops the database named in `url` if it exists, creates it again
  and runs `runHexaiMigrations()`. Never point it at a database you want to
  keep.
- `teardown()` closes its connections and drops the database.
- `tableManager` is a [`TableManager`](#database-utilities) on the test
  database, and `client` is its `pg.Client`.
- `newClient()` creates a new, unconnected `pg.Client` for `url`.

It connects to the server's `postgres` database to create and drop the test
database, so the role needs the `CREATEDB` privilege.

## API reference

### `@hexaijs/postgres`

| Export | Description |
|--------|-------------|
| `createPostgresUnitOfWork` | Creates a `DefaultPostgresUnitOfWork` from a `pg.Pool`, a connection string or a `PostgresConfig` |
| `PostgresUnitOfWork` | Interface: `scope()`, `db`, transaction lifecycle hooks, `onEveryCommit()`, and the deprecated `withClient()` and `getClient()` |
| `DefaultPostgresUnitOfWork` | The implementation; also implements `CommitControl` and `TransactionResources` |
| `PostgresQueryable` | Type of `db`: only `query()`, which pg's `Client`, `PoolClient` and `Pool` also fit |
| `PostgresUnitOfWorkObserver` | Postgres-only capability for instance-level `onEveryCommit()` observers |
| `CommitControl` | Postgres-only capability for marking the current transaction as rollback-only while preserving the callback result |
| `TransactionResources` | Postgres-only capability for transaction-scoped resources |
| `TransactionResourceAware` | Deprecated alias for `TransactionResources` |
| `createTransactionResourceKey` | Creates typed keys for transaction-scoped resources |
| `IsolationLevel` | Transaction isolation level enum |
| `ClientFactory`, `ClientCleanUp`, `PostgresTransactionOptions` | Types of the `DefaultPostgresUnitOfWork` constructor arguments and of the `scope()` options |
| `PostgresEventStore` | Event store implementation with batch insert support |
| `PostgresTransactionalEventStoreSink` | Transaction-local event-store sink with drain-phase append and optional `onStored` callback |
| `attachPostgresEventStoreSink` | Attaches a `PostgresTransactionalEventStoreSink` to a subscribable event publisher |
| `PostgresConfig` | Immutable connection configuration with `with*` builder methods (from `ezcfg/postgres`) |
| `postgresConfig`, `PostgresConfigSpec` | Config spec for `defineConfig` (from `ezcfg/postgres`) |
| `runMigrations` | Migration runner for SQL and JavaScript migrations |
| `runHexaiMigrations` | Runs the built-in event store migrations |
| `DatabaseManager` | Creates and drops databases |
| `TableManager` | Table operations (exists, create, truncate, drop, schema) |
| `ClientWrapper` | Base class of `DatabaseManager` and `TableManager` |
| `ensureConnection` | Connects a client unless it is already connected |

### `@hexaijs/postgres/projection`

| Export | Description |
|--------|-------------|
| `ProjectionEngine` | Registers read models, polls the event store and rebuilds projections |
| `IPostgresReadModel` | Read model interface: `name`, `version`, `canHandle()`, `apply()`, `reset()` |
| `SelectorBasedReadModel` | Base class whose handlers are selected with `@When` |
| `When`, `eventTypeMatches` | Decorator and predicate for selecting handlers by event type |
| `ProjectionWakeQueue` | Coalesces wake-up signals into `poll()` calls; create it with `engine.createWakeQueue()` |
| `runProjectionMigrations` | Creates the projection checkpoint table (also exported from `@hexaijs/postgres/projection/migrations`) |
| `ProjectionEngineLogger`, `ProjectionEngineOptions`, `ProjectionStatus`, `ProjectionMode`, `ProjectionHealth`, `ReadableEventStore` | Types for the engine's logger, options and status |

### `@hexaijs/postgres/test`

| Export | Description |
|--------|-------------|
| `PostgresUnitOfWorkForTesting` | `PostgresUnitOfWork` that runs inside an external transaction |
| `createTestContext` | Creates, migrates and drops a throwaway test database |

### Errors

| Error | Thrown when |
|-------|-------------|
| `TransactionAbortedError` | An aborted root transaction would otherwise finalize normally, or PostgreSQL answers `COMMIT` with `ROLLBACK` |
| `TransactionClosedError` | Work, including a query through a client the transaction handed out, tries to use a transaction that no longer accepts work because it is finalizing or finalized |
| `UnsupportedNestedTransactionCapabilityError` | Root-only transaction capabilities are used inside a nested savepoint, or a `NESTED` scope opens beside a running sibling |
| `IncompatibleIsolationLevelError` | A joining scope asks for an isolation level other than its transaction's |
| `TransactionalEventStoreSinkClosedError` | Events are accepted after the transaction-local sink has already drained |

## Migration guide

### v0.15.x → v0.16.0

**New: `db` for queries**

Send queries through `db` instead of a client callback. `db` routes each query
to the transaction of the current scope, or runs it on its own outside any
scope, so a repository can take it once:

```typescript
// Before
await unitOfWork.withClient((client) =>
    client.query("INSERT INTO orders (id) VALUES ($1)", [orderId])
);

// After
await unitOfWork.db.query("INSERT INTO orders (id) VALUES ($1)", [orderId]);
```

`withClient()` and `getClient()` are deprecated. Keep `withClient()` only for
work that needs the pg client itself, such as `COPY`.

**Removed: `wrap()`**

Replace `wrap(fn, options)` with `scope(fn, options)` and query through `db`
inside it.

**Changed: `query_timeout` counts from a query's turn**

Inside a transaction, pg's `query_timeout` now starts when the query's turn in
the transaction's [statement line](#the-statement-line) comes. 0.15.x handed
overlapping queries to pg's own queue, where the timeout started when the query
was made.

The other behavior changes of 0.16.0 are listed with migration notes in the
CHANGELOG.

**Peer dependency:** `pg` `^8.12.0`.

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

`wrap()` was deprecated here and removed in 0.16.0.

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
- [@hexaijs/application](../application/README.md) - Applications, handlers and the application context through which your handlers reach a unit of work
- [@hexaijs/sqlite](../sqlite/README.md) - SQLite unit of work for tests and single-connection use
