export enum Propagation {
    NEW = "new",
    EXISTING = "existing",
    NESTED = "nested",
}

export type TransactionHook = () => void | Promise<void>;

export type BeforeCommitPhase = "main" | "drain";

export interface BeforeCommitOptions {
    phase?: BeforeCommitPhase;
}

export interface BaseUnitOfWorkOptions {
    propagation: Propagation;
}

export interface TransactionLifecycle {
    beforeCommit(
        hook: TransactionHook,
        options?: BeforeCommitOptions
    ): void;
    afterCommit(hook: TransactionHook): void;
    afterRollback(hook: TransactionHook): void;
}

export interface UnitOfWork<
    Client = unknown,
    Options extends BaseUnitOfWorkOptions = BaseUnitOfWorkOptions,
> extends TransactionLifecycle {
    getClient(): Client;

    scope<T>(
        fn: () => Promise<T>,
        options?: Partial<Options>
    ): Promise<T>;

    /** @deprecated Use scope() for transaction boundaries and withClient() for client access. */
    wrap<T>(
        fn: (client: Client) => Promise<T>,
        options?: Partial<Options>
    ): Promise<T>;
}
