export declare enum Propagation {
    NEW = "new",
    EXISTING = "existing",
    NESTED = "nested"
}
export declare enum IsolationLevel {
    READ_UNCOMMITTED = "read uncommitted",
    READ_COMMITTED = "read committed",
    REPEATABLE_READ = "repeatable read",
    SERIALIZABLE = "serializable"
}
export interface CommonUnitOfWorkOptions {
    propagation: Propagation;
}
export interface UnitOfWork<Client = unknown, Options extends CommonUnitOfWorkOptions = CommonUnitOfWorkOptions> {
    getClient(): Client;
    wrap<T>(fn: (client: Client) => Promise<T>, options?: Partial<Options>): Promise<T>;
}
export type OptionsOf<U extends UnitOfWork> = U extends UnitOfWork<any, infer O> ? O : never;
export declare class UnitOfWorkAbortedError extends Error {
}
//# sourceMappingURL=unit-of-work.d.ts.map