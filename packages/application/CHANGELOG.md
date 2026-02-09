# Changelog

## [0.3.1] - 2026-02-09

### Breaking Changes

- **MessageWithAuth constructor signature changed** from `(payload, headers?, securityContext?)` to `(payload, options?: MessageWithAuthOptions)`
  - Migration: Replace `new MyCommand(payload, headers, sc)` with `new MyCommand(payload, { headers, securityContext: sc })`
  - This applies to `Command` and `Query` (which extend `MessageWithAuth`)

### Added

- `MessageWithAuthOptions<SecCtx>` interface (extends `MessageOptions`):
  ```typescript
  interface MessageWithAuthOptions<SecCtx> extends MessageOptions {
      securityContext?: SecCtx;
  }
  ```

### Removed

- `clone()`, `cloneWithHeaders()`, `withHeader()` overrides in `MessageWithAuth` - now inherited from `Message` base class

## [0.2.0] - 2026-02-03

### Added

- `Command<Payload, ResultType, SecurityContext>` - 3-param pattern with automatic output type inference
- `Query<Payload, ResultType, SecurityContext>` - 3-param pattern with automatic output type inference
- `CommandOutput<C>` / `QueryOutput<Q>` type utilities for extracting ResultType
- Phantom type `ResultType` for TypeScript type inference support

### Changed

- **BREAKING**: `Command<P, SC>` -> `Command<P, O, SC>` type parameter order
- **BREAKING**: `Query<P, SC>` -> `Query<P, O, SC>` type parameter order
- **BREAKING**: `CommandHandler<I, O, Ctx>` -> `CommandHandler<I, Ctx>` (O auto-inferred from Command)
- **BREAKING**: `QueryHandler<I, O, Ctx>` -> `QueryHandler<I, Ctx>` (O auto-inferred from Query)

### Migration Guide

```typescript
// AS-IS (v0.1.x)
class CreateUser extends Command<CreateUserPayload, MySecurityContext> {}
class CreateUserHandler implements CommandHandler<CreateUser, UserResult, Ctx> {
    execute(cmd: CreateUser): Promise<UserResult> { ... }
}

// TO-BE (v0.2.0)
class CreateUser extends Command<CreateUserPayload, UserResult, MySecurityContext> {}
class CreateUserHandler implements CommandHandler<CreateUser, Ctx> {
    execute(cmd: CreateUser): Promise<CreateUser['ResultType']> { ... }
}
```
