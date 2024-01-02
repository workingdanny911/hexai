export enum Propagation {
    NEW = "new",
    EXISTING = "existing",
    NESTED = "nested",
}

export enum IsolationLevel {
    READ_UNCOMMITTED = "read uncommitted",
    READ_COMMITTED = "read committed",
    REPEATABLE_READ = "repeatable read",
    SERIALIZABLE = "serializable",
}

export interface BaseUnitOfWorkOptions {
    propagation: Propagation;
}

export interface UnitOfWork<
    Client = unknown,
    Options extends BaseUnitOfWorkOptions = BaseUnitOfWorkOptions,
> {
    getClient(): Client;
    wrap<T>(
        fn: (client: Client) => Promise<T>,
        options?: Partial<Options>
    ): Promise<T>;
}

export type OptionsOfUnitOfWork<U extends UnitOfWork> = U extends UnitOfWork<
    any,
    infer O
>
    ? O
    : never;

export class UnitOfWorkAbortedError extends Error {}
