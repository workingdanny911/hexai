# Projection Infrastructure

`@hexaijs/postgres/projection` turns the append-only `PostgresEventStore` stream
into queryable read models. It is a **single-process, single-owner** projection
engine: exactly one process owns the projection workers for a given database.

This document explains how the pieces fit together, the guarantees it provides,
and the failure modes you should design for. For the multi-process roadmap
(lease, fencing, checkpoint compare-and-swap), see the workspace `docs/`.

## Components

| Component | Responsibility |
| --- | --- |
| `ProjectionEngine` | Owns runners, drives polling, coordinates startup/version rebuilds, exposes `start`/`stop`/`poll`/`resetProjection`/`getStatus`. |
| `IPostgresReadModel` | Your read model: `canHandle(storedEvent)`, `apply(storedEvent, client)`, `reset(client)`. |
| `SelectorBasedReadModel` | Optional base class: declare handlers with the `@When(...)` decorator and `eventTypeMatches(...)`. |
| `ProjectionRunner` | Per-read-model state machine (mode/health/position) for the live path. |
| `ProjectionRebuildContext` | Batched catch-up apply for one read model during a rebuild. |
| `StartupRebuildCoordinator` | Streams the event store once and fans each event out to all rebuilding contexts. |
| `CheckpointStore` | Reads/writes `projection__checkpoints` (`last_position`, `version`, `status`). |
| `ProjectionWakeQueue` | Coalesces "new events" signals into `poll()` calls. |

## Read model API

A read model receives the full `StoredEvent`, so it can persist the global
`position` alongside its own data:

```typescript
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

The engine deduplicates at the checkpoint level, so `apply()` runs effectively
once per event; keeping it idempotent is still recommended — see
[Delivery semantics](#delivery-semantics).

## Lifecycle

```
register(readModel)        // before start; duplicate names fail fast
  -> start()               // initialize() each runner, then background rebuild
       -> poll() (loop)     // safety interval + wake queue
  -> stop()                // drain in-flight poll/rebuild/reset, then halt
```

On `start()`, each runner calls `initialize()`, which reads its checkpoint:

- **no checkpoint, or `version` mismatch** → reset the read model + checkpoint and
  rebuild from position 0.
- **`status = 'rebuilding'`** → resume the rebuild.
- **`status = 'isolated'`** → stay isolated (excluded from polling until reset).
- **`status = 'running'`** → resume live polling from `last_position`.

## Live polling

`poll()` is serialized (one poll at a time) and is triggered two ways:

1. A safety interval (`safetyIntervalMs`).
2. `ProjectionWakeQueue.wake()`, typically from an `afterCommit` hook right after
   you append events.

A single poll opens one event-store stream from the minimum position across
active runners and feeds each event to every runner whose position is behind it.
Each event is applied through `processEvent`, which wraps the read model write
and the checkpoint advance in **one transaction**.

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
after a commit-ambiguous failure** — the server commits, but the client sees an
error (e.g. the connection drops before the `COMMIT` acknowledgement arrives),
so the engine retries an event that already landed.

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

Keep `apply()` idempotent as defense-in-depth (prefer upserts / `ON CONFLICT`)
— it costs little and protects you if an implementation ever violates
invariant 2.

## Failure handling

Failures on the live path act as an **ordering barrier**. When `apply()` throws:

- The transaction rolls back (no partial write, checkpoint unchanged).
- The runner retries the same position on subsequent polls, up to `maxRetries`.
- Other runners keep progressing; only the failing runner is blocked for that poll.
- After `maxRetries`, the runner becomes **isolated**: `status = 'isolated'` is
  upserted into the checkpoint (durable even if no checkpoint row existed yet),
  the runner stops polling, and it stays isolated across restarts until
  `resetProjection()` is called. Failures to persist isolation are surfaced via
  `logger.pollError`.

## Rebuilds

A rebuild streams the event store once (via `StartupRebuildCoordinator`) and
applies events in batches per read model, advancing the checkpoint with
`status = 'rebuilding'`. A batch that fails the configured retries falls back to
single-event application; an event that still fails isolates that read model.

Rebuilds happen on:

- **Startup**, for any read model whose checkpoint is `rebuilding` or absent.
- **Version change**, when `readModel.version` differs from the stored checkpoint.
- **`resetProjection(name)`**, which resets the read model + checkpoint and
  rebuilds from scratch. Resets are serialized and awaited by `stop()`.

If a rebuild ends without reaching the target position (e.g. a non-monotonic
event store) or throws, the runner is not left silently stuck in `rebuilding`:
it is activated at its current position or surfaced as isolated, and logged.

## Configuration

`ProjectionEngineOptions`: `streamBatchSize`, `maxRetries`, `safetyIntervalMs`,
`rebuildBatchSize`, `rebuildFlushConcurrency` (all positive integers).

## Migrations

Run the checkpoint migration before starting workers:

```typescript
import { runProjectionMigrations } from "@hexaijs/postgres/projection";

await runProjectionMigrations("postgres://user:pass@localhost:5432/mydb");
```

This creates `projection__checkpoints` (`projection_name` PK, `last_position`,
`version`, `status`).

## Scope and non-goals

This engine assumes a single owning process. It does **not** provide
multi-process ownership, leases, fencing tokens, or checkpoint compare-and-swap;
running two engines against the same projection on the same database is unsafe.
Those guarantees are tracked on the roadmap.
