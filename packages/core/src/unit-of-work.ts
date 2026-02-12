export enum Propagation {
    NEW = "new",
    EXISTING = "existing",
    NESTED = "nested",
}

export interface BaseUnitOfWorkOptions {
    propagation: Propagation;
}

export interface UnitOfWork<
    Client = unknown,
    Options extends BaseUnitOfWorkOptions = BaseUnitOfWorkOptions,
> {
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

