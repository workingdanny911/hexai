import { AsyncLocalStorage } from "node:async_hooks";

import * as pg from "pg";

import { Propagation } from "@hexaijs/core";
import { PostgresConfig } from "ezcfg/postgres";
import {
    ClientCleanUp,
    ClientFactory,
    PostgresTransactionOptions,
} from "./types.js";
import { ensureConnection } from "./helpers.js";
import {
    type PostgresQueryable,
    singleStatementQuery,
} from "./postgres-queryable.js";
import {
    type FailureAwareClientCleanUp,
    PostgresTransaction,
} from "./transaction/postgres-transaction.js";
import { TransactionClosedError } from "./transaction/errors.js";
import type { TransactionResourceKey } from "./transaction/resource-key.js";
import type {
    BeforeCommitOptions,
    TransactionLifecycle,
    TransactionHook,
    UnitOfWorkClientAccess,
} from "@hexaijs/core";

export {
    IncompatibleIsolationLevelError,
    TransactionAbortedError,
    TransactionClosedError,
    UnsupportedNestedTransactionCapabilityError,
} from "./transaction/errors.js";
export {
    createTransactionResourceKey,
    type TransactionResourceKey,
} from "./transaction/resource-key.js";

export interface CommitControl {
    preventCommit(cause?: unknown): void;
    isCommitPrevented(): boolean;
}

export interface TransactionResources {
    getTransactionResource<T>(
        key: TransactionResourceKey<T>
    ): T | undefined;
    getOrCreateTransactionResource<T>(
        key: TransactionResourceKey<T>,
        factory: () => T
    ): T;
    setTransactionResource<T>(
        key: TransactionResourceKey<T>,
        value: T
    ): void;
}

/** @deprecated Use TransactionResources. */
export type TransactionResourceAware = TransactionResources;

export interface PostgresUnitOfWorkObserver {
    onEveryCommit(observer: TransactionHook): () => void;
}

export interface PostgresUnitOfWork
    extends Omit<
            UnitOfWorkClientAccess<pg.ClientBase, PostgresTransactionOptions>,
            "wrap"
        >,
        TransactionLifecycle,
        PostgresUnitOfWorkObserver {
    /**
     * Runs queries in the transaction of the current scope. It is always the
     * same object, so keep it and use it at any time: each query goes to the
     * transaction that is current when it is called. Inside a scope, the first
     * query begins the transaction, and a query made after the scope's outcome
     * is decided rejects with `TransactionClosedError`. Outside any scope, each
     * query borrows a connection for itself and commits on its own, as
     * `pool.query()` does. Every call sends exactly one statement.
     */
    readonly db: PostgresQueryable;

    /**
     * @deprecated Use `db` for queries. Work that needs the pg client itself,
     * such as COPY, can keep using withClient() for now; its replacement will
     * be decided before withClient() is removed in the next major version.
     */
    withClient<T>(fn: (client: pg.ClientBase) => Promise<T>): Promise<T>;

    /** @deprecated Use `db`. getClient() will be removed in the next major version. */
    getClient(): pg.ClientBase;
}

export class DefaultPostgresUnitOfWork
    implements PostgresUnitOfWork, CommitControl, TransactionResources {
    private transactionStorage = new AsyncLocalStorage<PostgresTransaction>();
    private everyCommitObservers = new Set<TransactionHook>();

    readonly db: PostgresQueryable = {
        query: async (text, values) => {
            const query = singleStatementQuery(text, values);
            const transaction = this.getCurrentTransaction();
            if (transaction) {
                return transaction.useClient(
                    (client) => client.query(query),
                    "db.query()"
                );
            }
            return this.queryOnOwnConnection(query);
        },
    };

    private readonly clientCleanUp?: FailureAwareClientCleanUp;

    constructor(
        private clientFactory: ClientFactory,
        clientCleanUp?: ClientCleanUp
    ) {
        this.clientCleanUp = clientCleanUp;
    }

    /** @deprecated Use `db`. getClient() will be removed in the next major version. */
    public getClient(): pg.ClientBase {
        const current = this.getCurrentTransaction();

        if (!current) {
            throw new Error("Unit of work not started");
        }

        return current.getClient();
    }

    async scope<T = unknown>(
        fn: () => Promise<T>,
        options: Partial<PostgresTransactionOptions> = {}
    ): Promise<T> {
        const resolvedOptions = this.resolveOptions(options);
        const { transaction, created } =
            this.resolveTransaction(resolvedOptions);

        return this.executeInContext(transaction, (tx) =>
            created
                ? tx.ownScope(fn, resolvedOptions)
                : tx.joinScope(fn, resolvedOptions)
        );
    }

    beforeCommit(
        hook: TransactionHook,
        options?: BeforeCommitOptions
    ): void {
        const tx = this.getRequiredTransaction("beforeCommit");
        tx.addBeforeCommitHook(hook, options);
    }

    afterCommit(hook: TransactionHook): void {
        const tx = this.getRequiredTransaction("afterCommit");
        tx.addAfterCommitHook(() => this.runOutsideTransactionContext(hook));
    }

    afterRollback(hook: TransactionHook): void {
        const tx = this.getRequiredTransaction("afterRollback");
        tx.addAfterRollbackHook(() => this.runOutsideTransactionContext(hook));
    }

    onEveryCommit(observer: TransactionHook): () => void {
        this.everyCommitObservers.add(observer);

        let subscribed = true;
        return () => {
            if (!subscribed) {
                return;
            }

            subscribed = false;
            this.everyCommitObservers.delete(observer);
        };
    }

    preventCommit(cause?: unknown): void {
        const tx = this.getRequiredTransaction("preventCommit");
        tx.preventCommit(cause);
    }

    isCommitPrevented(): boolean {
        const tx = this.getRequiredTransaction("isCommitPrevented");
        return tx.isCommitPrevented();
    }

    getTransactionResource<T>(
        key: TransactionResourceKey<T>
    ): T | undefined {
        const tx = this.getRequiredTransaction("getTransactionResource");
        return tx.getResource(key);
    }

    getOrCreateTransactionResource<T>(
        key: TransactionResourceKey<T>,
        factory: () => T
    ): T {
        const tx = this.getRequiredTransaction(
            "getOrCreateTransactionResource"
        );
        return tx.getOrCreateResource(key, factory);
    }

    setTransactionResource<T>(
        key: TransactionResourceKey<T>,
        value: T
    ): void {
        const tx = this.getRequiredTransaction("setTransactionResource");
        tx.setResource(key, value);
    }

    /** @deprecated Use `db` for queries. See `PostgresUnitOfWork.withClient()`. */
    withClient<T>(fn: (client: pg.ClientBase) => Promise<T>): Promise<T> {
        const transaction = this.getCurrentTransaction();
        if (transaction) {
            return transaction.useClient(fn, "withClient()");
        }
        return this.withOwnConnection(fn);
    }

    // Outside any scope, db.query() works as pool.query(): the connection
    // goes back after the query, or is destroyed when the query failed, since
    // it may still be busy with it, for example after pg's query_timeout.
    private async queryOnOwnConnection(
        query: pg.QueryConfig
    ): Promise<pg.QueryResult> {
        const client = await this.clientFactory();
        let result: pg.QueryResult;
        try {
            await ensureConnection(client);
            result = await client.query(query);
        } catch (failure) {
            await this.clientCleanUp?.(client, failure);
            throw failure;
        }
        await this.clientCleanUp?.(client);
        return result;
    }

    // Outside any scope, withClient() works as pool.connect() with release()
    // in finally: the connection goes back whether fn succeeds or fails.
    private async withOwnConnection<T>(
        fn: (client: pg.ClientBase) => Promise<T>
    ): Promise<T> {
        const client = await this.clientFactory();
        try {
            await ensureConnection(client);
            return await fn(client);
        } finally {
            await this.clientCleanUp?.(client);
        }
    }

    private getCurrentTransaction(): PostgresTransaction | null {
        return this.transactionStorage.getStore() ?? null;
    }

    private getRequiredTransaction(operation: string): PostgresTransaction {
        const tx = this.getCurrentTransaction();
        if (!tx) {
            throw new Error(
                `Cannot use ${operation} outside of a transaction scope`
            );
        }
        if (tx.isClosed()) {
            throw new TransactionClosedError(operation);
        }
        return tx;
    }

    private runOutsideTransactionContext(
        hook: TransactionHook
    ): void | Promise<void> {
        return this.transactionStorage.exit(() => hook());
    }

    private async notifyEveryCommit(): Promise<void> {
        const observers = Array.from(this.everyCommitObservers);
        if (observers.length === 0) {
            return;
        }

        await this.transactionStorage.exit(async () => {
            for (const observer of observers) {
                try {
                    await observer();
                } catch (e) {
                    console.error(
                        "PostgresUnitOfWork onEveryCommit observer failed",
                        e
                    );
                }
            }
        });
    }

    private resolveOptions(
        options: Partial<PostgresTransactionOptions>
    ): PostgresTransactionOptions {
        return {
            propagation: Propagation.EXISTING,
            ...options,
        };
    }

    // The call that creates a transaction owns it: only that call finalizes
    // it. Calls that join an existing transaction take part without ending it.
    private resolveTransaction(options: PostgresTransactionOptions): {
        transaction: PostgresTransaction;
        created: boolean;
    } {
        const current = this.getCurrentTransaction();
        return current && options.propagation !== Propagation.NEW
            ? { transaction: current, created: false }
            : { transaction: this.createTransaction(), created: true };
    }

    private createTransaction(): PostgresTransaction {
        return new PostgresTransaction(
            this.clientFactory,
            this.clientCleanUp,
            () => this.notifyEveryCommit()
        );
    }

    private executeInContext<T>(
        transaction: PostgresTransaction,
        callback: (transaction: PostgresTransaction) => Promise<T>
    ): Promise<T> {
        return this.transactionStorage.run(transaction, () =>
            callback(transaction)
        );
    }
}

export function createPostgresUnitOfWork(
    pool: pg.Pool
): DefaultPostgresUnitOfWork;
export function createPostgresUnitOfWork(
    config: PostgresConfig | string
): DefaultPostgresUnitOfWork;
export function createPostgresUnitOfWork(
    source: pg.Pool | PostgresConfig | string
): DefaultPostgresUnitOfWork {
    if (source instanceof pg.Pool) {
        return new DefaultPostgresUnitOfWork(
            async () => source.connect(),
            releasePoolClient
        );
    }

    const connectionString =
        source instanceof PostgresConfig ? source.toString() : source;

    return new DefaultPostgresUnitOfWork(
        () => new pg.Client({ connectionString }),
        (client) => (client as pg.Client).end()
    );
}

// The unit of work passes a second argument exactly when the client is in an
// unknown state, whatever the failure is: a query may reject with undefined.
function releasePoolClient(
    client: pg.ClientBase,
    ...failure: [] | [unknown]
): void {
    const poolClient = client as pg.PoolClient;
    if (failure.length === 0) {
        poolClient.release();
        return;
    }

    // pg-pool destroys a client released with a truthy argument instead of
    // returning it to the pool in an unknown state.
    const [cause] = failure;
    poolClient.release(cause instanceof Error ? cause : true);
}
