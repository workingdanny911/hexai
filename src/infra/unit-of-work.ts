export default interface UnitOfWork<Client = unknown, Options = unknown> {
    getClient(): Client;

    wrap<T>(fn: (client: Client) => Promise<T>, options?: Options): Promise<T>;

    wrapWithNew<T>(
        fn: (client: Client) => Promise<T>,
        options?: Options
    ): Promise<T>;
}

export type UnitOfWorkOptions<UoW extends UnitOfWork<any, any>> =
    UoW extends UnitOfWork<any, infer Options> ? Options : never;
