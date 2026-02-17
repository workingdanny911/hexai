import { AsyncLocalStorage } from "node:async_hooks";

import * as pg from "pg";

import { Propagation, TransactionHooks, UnitOfWork } from "@hexaijs/core";
import type { TransactionHook } from "@hexaijs/core";
import { PostgresConfig } from "./config";
import { IsolationLevel } from "./types";
import {
    ClientCleanUp,
    ClientFactory,
    PostgresTransactionOptions,
} from "./types";
import { ensureConnection } from "./helpers";

export interface PostgresUnitOfWork
    extends UnitOfWork<pg.ClientBase, PostgresTransactionOptions> {
    withClient<T>(fn: (client: pg.ClientBase) => Promise<T>): Promise<T>;
}

export class DefaultPostgresUnitOfWork implements PostgresUnitOfWork {
    private static wrapDeprecationEmitted = false;
    private transactionStorage = new AsyncLocalStorage<PostgresTransaction>();

    constructor(
        private clientFactory: ClientFactory,
        private clientCleanUp?: ClientCleanUp
    ) {}

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
        const transaction = this.resolveTransaction(resolvedOptions);

        return this.executeInContext(transaction, (tx) =>
            tx.executeScope(fn, resolvedOptions)
        );
    }

    async wrap<T = unknown>(
        fn: (client: pg.ClientBase) => Promise<T>,
        options: Partial<PostgresTransactionOptions> = {}
    ): Promise<T> {
        if (!DefaultPostgresUnitOfWork.wrapDeprecationEmitted) {
            DefaultPostgresUnitOfWork.wrapDeprecationEmitted = true;
            process.emitWarning(
                "UnitOfWork.wrap() is deprecated. Use scope() + withClient() instead.",
                { type: "DeprecationWarning" }
            );
        }

        const resolvedOptions = this.resolveOptions(options);
        const transaction = this.resolveTransaction(resolvedOptions);

        return this.executeInContext(transaction, (tx) =>
            tx.execute(fn, resolvedOptions)
        );
    }

    beforeCommit(hook: TransactionHook): void {
        const tx = this.getRequiredTransaction("beforeCommit");
        tx.addBeforeCommitHook(hook);
    }

    afterCommit(hook: TransactionHook): void {
        const tx = this.getRequiredTransaction("afterCommit");
        tx.addAfterCommitHook(hook);
    }

    afterRollback(hook: TransactionHook): void {
        const tx = this.getRequiredTransaction("afterRollback");
        tx.addAfterRollbackHook(hook);
    }

    async withClient<T>(fn: (client: pg.ClientBase) => Promise<T>): Promise<T> {
        const currentTransaction = this.getCurrentTransaction();

        if (currentTransaction) {
            const client = await currentTransaction.getClientLazy();
            return fn(client);
        }

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

    private getRequiredTransaction(hookName: string): PostgresTransaction {
        const tx = this.getCurrentTransaction();
        if (!tx) {
            throw new Error(
                `Cannot register ${hookName} hook outside of a transaction scope`
            );
        }
        return tx;
    }

    private resolveOptions(
        options: Partial<PostgresTransactionOptions>
    ): PostgresTransactionOptions {
        return {
            propagation: Propagation.EXISTING,
            ...options,
        };
    }

    private resolveTransaction(
        options: PostgresTransactionOptions
    ): PostgresTransaction {
        if (options.propagation === Propagation.NEW) {
            return this.createTransaction();
        }
        return this.getCurrentTransaction() ?? this.createTransaction();
    }

    private createTransaction(): PostgresTransaction {
        return new PostgresTransaction(this.clientFactory, this.clientCleanUp);
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

class PostgresTransaction {
    private initialized = false;
    private closed = false;
    private abortError?: Error;

    private nestingDepth = 0;
    private options!: PostgresTransactionOptions;

    private client!: pg.ClientBase;
    private savepoints: Savepoint[] = [];
    private hooks = new TransactionHooks();

    constructor(
        private clientFactory: ClientFactory,
        private clientCleanUp?: ClientCleanUp
    ) {}

    public addBeforeCommitHook(hook: TransactionHook): void {
        this.hooks.addBeforeCommit(hook);
    }

    public addAfterCommitHook(hook: TransactionHook): void {
        this.hooks.addAfterCommit(hook);
    }

    public addAfterRollbackHook(hook: TransactionHook): void {
        this.hooks.addAfterRollback(hook);
    }

    public async execute<T>(
        fn: (client: pg.ClientBase) => Promise<T>,
        options: PostgresTransactionOptions
    ): Promise<T> {
        this.options = options;
        await this.ensureStarted();

        const executor = this.resolveExecutor(options.propagation);
        return executor === this
            ? this.runWithLifecycle(fn)
            : executor.execute(fn, options);
    }

    public async executeScope<T>(
        fn: () => Promise<T>,
        options: PostgresTransactionOptions
    ): Promise<T> {
        this.options = options;

        if (this.nestingDepth > 0 && options.propagation === Propagation.NESTED) {
            await this.ensureStarted();
            const savepoint = this.createSavepoint();
            return savepoint.execute(() => fn());
        }

        return this.runScopedLifecycle(fn);
    }

    public async getClientLazy(): Promise<pg.ClientBase> {
        await this.ensureStarted();
        return this.client;
    }

    public getClient(): pg.ClientBase {
        if (!this.initialized) {
            throw new Error(
                "Transaction not initialized. Use withClient() inside scope() to trigger lazy initialization."
            );
        }
        return this.client;
    }

    private async ensureStarted(): Promise<void> {
        if (this.initialized) {
            return;
        }

        this.initialized = true;
        await this.initializeClient();
        await this.beginTransaction();
    }

    private async initializeClient(): Promise<void> {
        const client = await this.clientFactory();

        if (!("query" in client)) {
            throw new Error("Client factory must return a pg.ClientBase");
        }

        await ensureConnection(client);
        this.client = client;
    }

    private async beginTransaction(): Promise<void> {
        await this.client.query("BEGIN");

        const isolationLevel =
            this.options.isolationLevel ?? IsolationLevel.READ_COMMITTED;
        if (isolationLevel !== IsolationLevel.READ_COMMITTED) {
            await this.client.query(
                `SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`
            );
        }
    }

    private async runWithLifecycle<T>(
        fn: (client: pg.ClientBase) => Promise<T>
    ): Promise<T> {
        try {
            return await this.executeWithNesting(fn);
        } catch (e) {
            console.error(`Transaction aborting, error in transaction:`);
            console.error(e);
            this.markAsAborted(e as Error);
            throw e;
        } finally {
            await this.finalizeIfRoot();
        }
    }

    private async runScopedLifecycle<T>(fn: () => Promise<T>): Promise<T> {
        this.nestingDepth++;
        try {
            return await fn();
        } catch (e) {
            this.markAsAborted(e as Error);
            throw e;
        } finally {
            this.nestingDepth--;
            await this.finalizeIfRoot();
        }
    }

    private async executeWithNesting<T>(
        fn: (client: pg.ClientBase) => Promise<T>
    ): Promise<T> {
        this.nestingDepth++;
        try {
            return await fn(this.client);
        } finally {
            this.nestingDepth--;
        }
    }

    private markAsAborted(error: Error): void {
        this.abortError = error;
    }

    private async finalizeIfRoot(): Promise<void> {
        if (this.nestingDepth === 0) {
            if (!this.initialized) return;

            if (this.isAborted()) {
                await this.hooks.executeRollback(
                    () => this.rollback(),
                    this.abortError
                );
            } else if (!this.closed) {
                await this.hooks.executeCommit(
                    () => this.commit(),
                    () => this.rollback()
                );
            }
        }
    }

    private resolveExecutor(
        propagation: Propagation
    ): PostgresTransaction | Savepoint {
        if (this.nestingDepth === 0) {
            return this;
        }

        return propagation === Propagation.NESTED
            ? this.createSavepoint()
            : (this.findActiveSavepoint() ?? this);
    }

    private createSavepoint(): Savepoint {
        const savepoint = new Savepoint(
            `sp_${this.savepoints.length + 1}`,
            this.client,
            () => this.removeSavepoint()
        );
        this.savepoints.push(savepoint);
        return savepoint;
    }

    private findActiveSavepoint(): Savepoint | undefined {
        for (let i = this.savepoints.length - 1; i >= 0; i--) {
            if (!this.savepoints[i].isClosed()) {
                return this.savepoints[i];
            }
        }
    }

    private removeSavepoint(): void {
        this.savepoints.pop();
    }

    private async commit(): Promise<void> {
        if (this.closed) {
            return;
        }

        this.closed = true;
        await this.client.query("COMMIT");
        await this.clientCleanUp?.(this.client);
    }

    private async rollback(): Promise<void> {
        if (this.closed) {
            return;
        }

        this.closed = true;

        try {
            await this.client.query("ROLLBACK");
        } catch (e) {
            if (
                e instanceof Error &&
                e.message.includes("Client was closed and is not queryable")
            ) {
                return;
            }
            throw e;
        }

        await this.clientCleanUp?.(this.client);
    }

    private isAborted(): boolean {
        return this.abortError !== undefined && !this.closed;
    }
}

class Savepoint {
    private initialized = false;
    private closed = false;
    private abortError?: Error;

    private nestingDepth = 0;

    constructor(
        private readonly name: string,
        private readonly client: pg.ClientBase,
        private readonly onClose: () => void
    ) {}

    public async execute<T>(
        fn: (client: pg.ClientBase) => Promise<T>
    ): Promise<T> {
        await this.ensureStarted();
        return this.runWithLifecycle(fn);
    }

    public isClosed(): boolean {
        return this.closed;
    }

    private async ensureStarted(): Promise<void> {
        if (this.initialized) {
            return;
        }

        this.initialized = true;
        await this.client.query(`SAVEPOINT ${this.name}`);
    }

    private async runWithLifecycle<T>(
        fn: (client: pg.ClientBase) => Promise<T>
    ): Promise<T> {
        this.nestingDepth++;
        try {
            return await fn(this.client);
        } catch (e) {
            this.markAsAborted(e as Error);
            throw e;
        } finally {
            this.nestingDepth--;
            await this.finalizeIfRoot();
        }
    }

    private markAsAborted(error: Error): void {
        this.abortError = error;
    }

    private async finalizeIfRoot(): Promise<void> {
        if (this.nestingDepth === 0) {
            await (this.isAborted() ? this.rollback() : this.commit());
        }
    }

    private async commit(): Promise<void> {
        if (this.closed) {
            return;
        }

        this.closed = true;
        await this.client.query(`RELEASE SAVEPOINT ${this.name}`);
        this.onClose();
    }

    private async rollback(): Promise<void> {
        if (this.closed) {
            return;
        }

        this.closed = true;
        await this.client.query(`ROLLBACK TO SAVEPOINT ${this.name}`);
        this.onClose();
    }

    private isAborted(): boolean {
        return this.abortError !== undefined && !this.closed;
    }
}

export function createPostgresUnitOfWork(pool: pg.Pool): PostgresUnitOfWork;
export function createPostgresUnitOfWork(
    config: PostgresConfig | string
): PostgresUnitOfWork;
export function createPostgresUnitOfWork(
    source: pg.Pool | PostgresConfig | string
): PostgresUnitOfWork {
    if (source instanceof pg.Pool) {
        return new DefaultPostgresUnitOfWork(
            async () => source.connect(),
            (client) => (client as pg.PoolClient).release()
        );
    }

    const connectionString =
        source instanceof PostgresConfig ? source.toString() : source;

    return new DefaultPostgresUnitOfWork(
        () => new pg.Client({ connectionString }),
        (client) => (client as pg.Client).end()
    );
}
