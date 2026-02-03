# Changelog

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
