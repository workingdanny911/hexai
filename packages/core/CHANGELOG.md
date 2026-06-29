# Changelog

## [0.12.0] - 2026-06-29

### Breaking Changes

- The base `UnitOfWork` interface now exposes only `scope()`. Consumers and
  implementations that need direct transaction client access should depend on
  `UnitOfWorkClientAccess`; consumers and implementations that need
  `beforeCommit`, `afterCommit`, or `afterRollback` should depend on
  `TransactionLifecycle`.

### Added

- Added `UnitOfWorkClientAccess` as the core capability interface for
  `getClient()` and deprecated `wrap()` support.
- Added `TransactionLifecycle` as the core capability interface for
  transaction lifecycle hooks.

## [0.11.0] - 2026-06-26

### Added

- Added event flow contracts: `EventPublisher`, `EventSubscriber`, and
  `SubscribableEventPublisher`.

## [0.10.0] - 2026-06-24

### Added

- Added `BeforeCommitOptions` with `phase: "main" | "drain"` so
  `beforeCommit` work can be split into ordinary commit guards and a final
  in-transaction drain phase.

## [0.9.4] - 2026-06-22

### Changed

- `Message` now shallow-copies object payloads before freezing them, so caller-owned payload objects remain mutable while message payloads stay immutable.
- `DomainEvent` now explicitly exposes the `(payload, options?)` constructor and forwards to `Message`.

## [0.9.2] - 2026-03-20

### Added

- `EventStore.stream?(afterPosition, batchSize): AsyncGenerator<StoredEvent>` — optional batch-based async streaming
- `EventStore.getEventCount?(afterPosition): Promise<number>` — optional event count query

Both methods are optional, so existing `EventStore` implementations are unaffected.

## [0.9.1] - 2026-03-07

### Changed

- Build tool migrated from tsup to tsgo (`@typescript/native-preview`)
- Module resolution switched to `nodenext` with explicit `.js` import extensions
- Removed path aliases (`@/*`) in favor of relative imports
- ESM-only output (CJS removed)

## [0.9.0] - 2026-02-19

### Breaking Changes

- **`setExpect()` removed** — `@hexaijs/core/test` testing helpers now import vitest directly
  - Migration: Remove `setExpect(expect)` calls from your test setup
  - `vitest` is added as an optional peerDependency (only needed in test environments)

### Added

- **`AggregateRoot.flushEvents()`** — returns collected events and clears the internal list
  - Unlike `getEventsOccurred()`, this resets the internal state
  - Useful for repository implementations that publish events after save

## [0.8.0] - 2026-02-15

### Breaking Changes

- **`UnitOfWork` interface: 3 new required methods** — all implementations must add these methods
  - `beforeCommit(hook: TransactionHook): void` — register a hook that runs before commit
  - `afterCommit(hook: TransactionHook): void` — register a hook that runs after commit (best-effort)
  - `afterRollback(hook: TransactionHook): void` — register a hook that runs after rollback (best-effort)
  - Hooks can only be registered inside an active `scope()` — calling outside throws an error

### Added

- `TransactionHook` type: `() => void | Promise<void>`
- `TransactionHooks` class: reusable hook registry with `executeCommit()` / `executeRollback()` lifecycle methods
  - `beforeCommit` hooks run sequentially; if any fails, triggers rollback instead of commit
  - `afterCommit` / `afterRollback` hooks run best-effort (all execute even if some fail, errors collected into `AggregateError`)

## [0.7.0] - 2026-02-12

### Added

- `UnitOfWork.scope()` — lazy transaction API that only begins a transaction on first resource access
  - Signature: `scope<T>(fn: () => Promise<T>, options?): Promise<T>`
  - Supports propagation options: `NEW`, `EXISTING` (default), `NESTED`

### Deprecated

- `UnitOfWork.wrap()` — use `scope()` instead
  - `wrap()` eagerly acquires a connection and begins a transaction immediately
  - `scope()` defers connection acquisition until first use, reducing unnecessary resource consumption

## [0.6.0] - 2026-02-09

### Added

- `MessageTrace` interface: `{ id: string; type: string }` for message identity in tracing
- `Message.asTrace()`: returns this message's identity as `MessageTrace`
- `Message.getCausation()`: gets the direct parent message trace from `"causation"` header
- `Message.getCorrelation()`: gets the root message trace from `"correlation"` header
- `Message.withCausation(trace)`: sets causation trace, returns new immutable instance
- `Message.withCorrelation(trace)`: sets correlation trace, returns new immutable instance

## [0.5.1] - 2026-02-09

### Breaking Changes

- **Message constructor signature changed** from `(payload, headers?)` to `(payload, options?: MessageOptions)`
  - Migration: Replace `new MyMessage(payload, headers)` with `new MyMessage(payload, { headers })`
- **Removed `doSerialize()`** - replaced by public `toJSON()` method
  - Migration: Override `serializePayload()` for custom serialization, or call `toJSON()` directly

### Added

- `MessageOptions` interface: `{ headers?: Record<string, unknown> }`
- `toJSON()` public method: returns `{ headers, payload }` (preserves Date objects)
- `serialize()` public method: returns fully serialized plain object (via `JSON.parse(JSON.stringify(toJSON()))`)
- `serializePayload()` protected hook for custom payload serialization
- `withHeader(field, value)` fluent API for adding headers (returns new instance)

### Changed

- `clone()` now uses `Object.create(Object.getPrototypeOf(this)) + Object.assign` (prototype-preserving)
- `clone()` and `cloneWithHeaders()` moved from `MessageWithAuth` to `Message` base class

## [0.4.0] - 2026-02-04

### Breaking Changes

- **Removed `QueryableUnitOfWork` interface**
  - This interface was only used by `@hexaijs/postgres`
  - Transaction-free queries are now provided directly by `@hexaijs/postgres` via `withClient()` method
  - Migration: No action needed if using `@hexaijs/postgres` - update to postgres 0.4.0

## [0.3.0] - 2026-02-03

### Added

- `QueryableUnitOfWork<Client, Options>` interface extending `UnitOfWork`
  - `query<T>(fn: (client: Client) => Promise<T>): Promise<T>` method for transaction-free queries
  - Context-aware: reuses existing client inside transactions, creates new connection outside
