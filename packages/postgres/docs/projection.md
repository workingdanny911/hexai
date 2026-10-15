# Projection Infrastructure

`@hexaijs/postgres/projection` turns the append-only `PostgresEventStore` stream
into queryable read models. A read model is a table shaped for queries; a
projection keeps it up to date by applying each stored event to it. The engine
is **single-process, single-owner**: exactly one process owns the projection
workers for a given database. Running projections from several processes is not
supported yet (see [Scope and non-goals](#scope-and-non-goals)).

This document explains how the pieces fit together, the guarantees the engine
provides, and the failure modes to design for. For installation and a setup
example, see the [package README](../README.md#projections).

## Components

| Component | Exported | Responsibility |
| --- | --- | --- |
| `ProjectionEngine` | Yes | Owns runners, drives polling, coordinates startup and version rebuilds, exposes `start`/`stop`/`poll`/`resetProjection`/`getStatus`. |
| `IPostgresReadModel` | Yes (type) | Your read model: `name`, `version`, `canHandle(storedEvent)`, `apply(storedEvent, client)`, `reset(client)`. |
| `SelectorBasedReadModel` | Yes | Optional base class: declare handlers with the `@When(...)` decorator and `eventTypeMatches(...)`. |
| `ProjectionWakeQueue` | Yes | Coalesces "new events" signals into `poll()` calls. Create it with `engine.createWakeQueue()`. |
| `ProjectionRunner` | No | Per-read-model state machine (mode, health, position) for the live path. |
| `ProjectionRebuildContext` | No | Batched catch-up apply for one read model during a rebuild. |
| `StartupRebuildCoordinator` | No | Streams the event store once and fans each event out to all rebuilding contexts. |
| `CheckpointStore` | No | Reads and writes `projection__checkpoints` (`last_position`, `version`, `status`). |

## Read model API

A read model receives the full `StoredEvent`, so it can persist the global
`position` alongside its own data:

```typescript
import {
    SelectorBasedReadModel,
    When,
    eventTypeMatches,
} from "@hexaijs/postgres/projection";

import type { StoredEvent } from "@hexaijs/core";
import type { ClientBase } from "pg";

class OrderSummary extends SelectorBasedReadModel {
    readonly name = "order-summary";
    readonly version = 1;

    @When(eventTypeMatches("order.placed"))
    async onPlaced(storedEvent: StoredEvent, client: ClientBase): Promise<void> {
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

`@When` is a legacy TypeScript decorator, so the project needs
`experimentalDecorators` enabled. `eventTypeMatches()` accepts an event type, an
array of types or a regular expression. When more than one handler of a
`SelectorBasedReadModel` matches an event, `apply()` throws, and the engine
treats that as a failed event (see [Failure handling](#failure-handling)).

`apply()` and `reset()` receive the client of the projection transaction. Write
through it, and do not release or end it: the unit of work owns it.

The engine deduplicates at the checkpoint level, so `apply()` runs effectively
once per event; keeping it idempotent is still recommended (see
[Delivery semantics](#delivery-semantics)).

## Lifecycle

```text
register(readModel)        // before start; duplicate names fail fast
  -> start()               // initialize() each runner, then background rebuild
       -> poll() (loop)    // safety interval + wake queue
  -> stop()                // cancel the rebuild, wait for in-flight poll/reset/rebuild, then halt
```

`register()` throws when a read model with the same name is already registered,
or when the engine has already started.

On `start()`, each runner calls `initialize()`, which reads its checkpoint:

- **no checkpoint, or `version` mismatch**: reset the read model and checkpoint,
  and rebuild from position 0.
- **`status = 'rebuilding'`**: resume the rebuild.
- **`status = 'isolated'`**: stay isolated (excluded from polling until reset).
- **`status = 'running'`**: resume live polling from `last_position`.

`start()` returns once every runner is initialized; rebuilds continue in the
background. `getStatus()` reports each projection's `mode`, `health`,
`lastPosition` and `retryCount`.

## Live polling

`poll()` is triggered two ways:

1. A safety interval (`safetyIntervalMs`).
2. `ProjectionWakeQueue.wake()`, typically from an `afterCommit` hook or an
   `onEveryCommit()` observer right after you append events.

Only one poll runs at a time. A `poll()` call made while another poll runs, or
while a projection is being reset, returns without polling. Events that the
running poll does not reach are picked up by a later poll, at the latest on the
safety interval.

Postgres `afterCommit` hooks run outside the completed transaction context, so a
wake can trigger polling without reusing the command transaction client that just
committed.

A single poll opens one event-store stream from the minimum position across
active runners and feeds each event to every runner whose position is behind it.
Each event is applied through `processEvent`, which wraps the read model write
and the checkpoint advance in **one transaction**.

This cursor model depends on event positions being commit-order safe. The default
`PostgresEventStore` enforces that at append time with a transaction-scoped
counter row, so a later position cannot become visible while an earlier position
is still uncommitted.

If event appends run inside a larger transaction, that counter row lock is held
until the larger transaction commits or rolls back. Append events near the end of
the transaction to keep concurrent writers moving.

## Delivery semantics

The read model write and the checkpoint advance commit **atomically** in a single
transaction (`scope()` + `withClient()`), and that transaction uses
`Propagation.NEW`, so projection writes never join an ambient caller transaction.
Consequences:

- A crash **before** commit replays the event (neither the write nor the
  checkpoint advanced). No events are skipped.
- A crash **after** commit leaves both the write and the checkpoint advanced. No
  reprocessing.
- Because `poll()` commits independently, triggering it from inside another
  transaction that later rolls back does **not** roll back projection progress or
  desynchronize the in-memory position from the database.

### Effectively-once processing

Atomic commits alone still leave one duplicate window: an **in-process retry
after a commit-ambiguous failure**. The server commits, but the client sees an
error (for example, the connection drops before the `COMMIT` acknowledgement
arrives), so the engine retries an event that already landed.

The engine closes this window with a **checkpoint-guarded transaction**: inside
the same transaction as the mutation, it locks the checkpoint row
(`SELECT ... FOR UPDATE`) and skips both the read model write and the checkpoint
save for any event whose position is already covered by the committed
checkpoint. The retry then sees the committed position, applies nothing, and
advances past the duplicate. The same guard protects rebuild batch flushes and
the single-event fallback.

Processing is therefore **effectively-once**. The guard's soundness rests on
three invariants:

1. **The checkpoint never moves backward.** It is the guard's source of truth;
   all engine writes keep `last_position` monotonically non-decreasing.
2. **Read model writes share the projection transaction.** An `apply()` that
   writes through anything other than the provided `client` forfeits the
   guarantee.
3. **A single process owns the projection** (see
   [Scope and non-goals](#scope-and-non-goals)). The row lock serializes
   accidental concurrent writers, but it is a safety net, not a multi-process
   ownership mechanism.

Keep `apply()` idempotent as defense-in-depth (prefer upserts or `ON CONFLICT`).
It costs little and protects you if an implementation ever violates
invariant 2.

## Failure handling

Failures on the live path act as an **ordering barrier**. When `apply()` throws:

- The transaction rolls back (no partial write, checkpoint unchanged).
- The runner tries the same position again on later polls.
- Other runners keep progressing; only the failing runner is blocked for that
  poll.
- After `maxRetries` failed attempts at the same position, the runner becomes
  **isolated**: `status = 'isolated'` is upserted into the checkpoint (durable
  even if no checkpoint row existed yet), the runner stops polling, and it stays
  isolated across restarts until `resetProjection()` is called. Failures to
  persist isolation are reported through `logger.pollError`.

## Rebuilds

A rebuild streams the event store once (via `StartupRebuildCoordinator`) and
applies events in batches per read model, advancing the checkpoint with
`status = 'rebuilding'`. It runs up to the last position at the time it starts;
live polling takes over from there. A batch that still fails after `maxRetries`
attempts falls back to applying its events one at a time; an event that still
fails isolates that read model.

Rebuilds happen on:

- **Startup**, for any read model whose checkpoint is `rebuilding` or absent.
- **Version change**, when `readModel.version` differs from the stored checkpoint.
- **`resetProjection(name)`**, which resets the read model and checkpoint and
  rebuilds from scratch. Resets are serialized and awaited by `stop()`.

If a rebuild ends without reaching the target position (for example with a
non-monotonic event store) or throws, the runner is not left silently stuck in
`rebuilding`: it is activated at its current position or surfaced as isolated,
and the problem is logged.

## Configuration

Pass `ProjectionEngineOptions` as the fourth argument of the `ProjectionEngine`
constructor. Every option must be a positive integer.

| Option | Default | Meaning |
| --- | --- | --- |
| `streamBatchSize` | `100` | Events fetched per batch when streaming the event store |
| `maxRetries` | `3` | Failed attempts at one position (or one rebuild batch) before giving up on it |
| `safetyIntervalMs` | `1000` | Interval of the safety poll, in milliseconds |
| `rebuildBatchSize` | `100` | Events applied per transaction during a rebuild |
| `rebuildFlushConcurrency` | `3` | Rebuild batches of different read models flushed at the same time |

## Migrations

Run the checkpoint migration before starting workers:

```typescript
import { runProjectionMigrations } from "@hexaijs/postgres/projection";

await runProjectionMigrations("postgres://user:pass@localhost:5432/mydb");
```

This creates `projection__checkpoints` (`projection_name` primary key,
`last_position`, `version`, `status`, `updated_at`).

## Scope and non-goals

This engine assumes a single owning process. It does **not** provide
multi-process ownership, leases, fencing tokens, or checkpoint compare-and-swap;
running two engines against the same projection on the same database is unsafe.
