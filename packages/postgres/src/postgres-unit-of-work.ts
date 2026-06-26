import { AsyncLocalStorage } from "node:async_hooks";

import * as pg from "pg";

import { Propagation, TransactionHooks } from "@hexaijs/core";
import { PostgresConfig } from "./config/index.js";
import { IsolationLevel } from "./types.js";
import {
    ClientCleanUp,
    ClientFactory,
    PostgresTransactionOptions,
} from "./types.js";
import { ensureConnection } from "./helpers.js";
import type {
    BeforeCommitOptions,
    TransactionHook,
    UnitOfWork,
} from "@hexaijs/core";

declare const transactionResourceKeyBrand: unique symbol;

export interface TransactionResourceKey<T> {
    readonly symbol: symbol;
    readonly description: string;
    readonly [transactionResourceKeyBrand]?: (value: T) => T;
}

export function createTransactionResourceKey<T>(
    description: string
): TransactionResourceKey<T> {
    return {
        symbol: Symbol(description),
        description,
    };
}

export interface CommitControl {
    preventCommit(cause?: unknown): void;
    isCommitPrevented(): boolean;
}

export interface TransactionResourceAware {
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

export class TransactionAbortedError extends Error {
    constructor(cause?: unknown) {
        super("Transaction was already aborted before root scope completed", {
            cause,
        });
        this.name = "TransactionAbortedError";
    }
}

export class TransactionClosedError extends Error {
    constructor(operation: string = "Transaction") {
        super(`${operation} cannot use a transaction that has already closed`);
        this.name = "TransactionClosedError";
    }
}

export class UnsupportedNestedTransactionCapabilityError extends Error {
    constructor(operation: string = "Transaction capabilities") {
        super(`${operation} is not supported inside nested savepoints`);
        this.name = "UnsupportedNestedTransactionCapabilityError";
    }
}

export interface PostgresUnitOfWork
    extends UnitOfWork<pg.ClientBase, PostgresTransactionOptions> {
    withClient<T>(fn: (client: pg.ClientBase) => Promise<T>): Promise<T>;
}

export class DefaultPostgresUnitOfWork
    implements PostgresUnitOfWork, CommitControl, TransactionResourceAware {
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
    private startPromise: Promise<void> | null = null;
    private transactionStarted = false;
    private closed = false;
    private abortError?: Error;
    private commitPrevented = false;
    private commitPreventionCause?: unknown;

    private nestingDepth = 0;
    private nestedSavepointDepth = 0;
    private options!: PostgresTransactionOptions;

    private client!: pg.ClientBase;
    private savepoints: Savepoint[] = [];
    private hooks = new TransactionHooks();
    private resources = new Map<symbol, unknown>();

    constructor(
        private clientFactory: ClientFactory,
        private clientCleanUp?: ClientCleanUp
    ) {}

    public addBeforeCommitHook(
        hook: TransactionHook,
        options?: BeforeCommitOptions
    ): void {
        this.hooks.addBeforeCommit(hook, options?.phase);
    }

    public addAfterCommitHook(hook: TransactionHook): void {
        this.hooks.addAfterCommit(hook);
    }

    public addAfterRollbackHook(hook: TransactionHook): void {
        this.hooks.addAfterRollback(hook);
    }

    public preventCommit(cause?: unknown): void {
        this.assertNotInNestedSavepoint("preventCommit()");
        if (!this.commitPrevented) {
            this.commitPrevented = true;
            this.commitPreventionCause = cause;
        }
    }

    public isCommitPrevented(): boolean {
        this.assertNotInNestedSavepoint("isCommitPrevented()");
        return this.commitPrevented;
    }

    public getResource<T>(
        key: TransactionResourceKey<T>
    ): T | undefined {
        this.assertNotInNestedSavepoint("Transaction resources");
        return this.resources.get(key.symbol) as T | undefined;
    }

    public getOrCreateResource<T>(
        key: TransactionResourceKey<T>,
        factory: () => T
    ): T {
        this.assertNotInNestedSavepoint("Transaction resources");
        if (!this.resources.has(key.symbol)) {
            this.resources.set(key.symbol, factory());
        }
        return this.resources.get(key.symbol) as T;
    }

    public setResource<T>(
        key: TransactionResourceKey<T>,
        value: T
    ): void {
        this.assertNotInNestedSavepoint("Transaction resources");
        this.resources.set(key.symbol, value);
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
            : this.runNestedSavepoint(() => executor.execute(fn, options));
    }

    public async executeScope<T>(
        fn: () => Promise<T>,
        options: PostgresTransactionOptions
    ): Promise<T> {
        this.options = options;

        if (this.nestingDepth > 0 && options.propagation === Propagation.NESTED) {
            await this.ensureStarted();
            const savepoint = this.createSavepoint();
            return this.runNestedSavepoint(() => savepoint.execute(() => fn()));
        }

        return this.runScopedLifecycle(fn);
    }

    public async getClientLazy(): Promise<pg.ClientBase> {
        this.assertOpen("withClient()");
        await this.ensureStarted();
        this.assertOpen("withClient()");
        return this.client;
    }

    public getClient(): pg.ClientBase {
        this.assertOpen("getClient()");
        if (!this.client) {
            throw new Error(
                "Transaction not initialized. Use withClient() inside scope() to trigger lazy initialization."
            );
        }
        return this.client;
    }

    public isClosed(): boolean {
        return this.closed;
    }

    private ensureStarted(): Promise<void> {
        if (!this.startPromise) {
            this.startPromise = this.doStart();
        }
        return this.startPromise;
    }

    private async doStart(): Promise<void> {
        await this.initializeClient();
        if (this.closed) {
            await this.clientCleanUp?.(this.client);
            return;
        }

        await this.beginTransaction();
        if (this.closed) {
            try {
                await this.client.query("ROLLBACK");
            } finally {
                this.transactionStarted = false;
                await this.clientCleanUp?.(this.client);
            }
        }
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
        this.transactionStarted = true;

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
        this.nestingDepth++;
        let callbackFailed = false;
        let callbackFailure: unknown;
        try {
            return await fn(this.client);
        } catch (e) {
            console.error(`Transaction aborting, error in transaction:`);
            console.error(e);
            this.markAsAborted(e as Error);
            callbackFailed = true;
            callbackFailure = e;
            throw e;
        } finally {
            this.nestingDepth--;
            await this.finalizeAfterCallback(callbackFailed, callbackFailure);
        }
    }

    private async runScopedLifecycle<T>(fn: () => Promise<T>): Promise<T> {
        this.nestingDepth++;
        let callbackFailed = false;
        let callbackFailure: unknown;
        try {
            return await fn();
        } catch (e) {
            this.markAsAborted(e as Error);
            callbackFailed = true;
            callbackFailure = e;
            throw e;
        } finally {
            this.nestingDepth--;
            await this.finalizeAfterCallback(callbackFailed, callbackFailure);
        }
    }

    private markAsAborted(error: Error): void {
        if (!this.abortError) {
            this.abortError = error;
        }
    }

    private async finalizeAfterCallback(
        callbackFailed: boolean,
        callbackFailure: unknown
    ): Promise<void> {
        if (this.nestingDepth !== 0) {
            return;
        }

        if (callbackFailed) {
            await this.hooks.executeRollback(
                () => this.rollback(),
                callbackFailure
            );
            return;
        }

        if (this.isAborted() && !this.commitPrevented) {
            await this.rollbackAndThrow(
                new TransactionAbortedError(this.abortError)
            );
        }

        if (this.isAborted() || this.commitPrevented) {
            await this.hooks.executeRollback(
                () => this.rollback(),
                this.abortError ?? this.commitPreventionCause
            );
            return;
        }

        if (this.closed) {
            return;
        }

        if (!this.startPromise || !this.client || !this.transactionStarted) {
            await this.closeWithoutDatabaseWork();
            return;
        }

        await this.hooks.executeCommit(
            () => this.commit(),
            () => this.rollback()
        );
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

    private async runNestedSavepoint<T>(fn: () => Promise<T>): Promise<T> {
        this.nestedSavepointDepth++;
        try {
            return await fn();
        } finally {
            this.nestedSavepointDepth--;
        }
    }

    private assertNotInNestedSavepoint(operation: string): void {
        if (this.nestedSavepointDepth > 0) {
            throw new UnsupportedNestedTransactionCapabilityError(operation);
        }
    }

    private assertOpen(operation: string): void {
        if (this.closed) {
            throw new TransactionClosedError(operation);
        }
    }

    private async closeWithoutDatabaseWork(): Promise<void> {
        this.closed = true;
        this.resources.clear();

        if (this.startPromise) {
            try {
                await this.startPromise;
            } catch {
                // The detached client acquisition path will surface its own error.
            }
        }
    }

    private async rollbackAndThrow(error: Error): Promise<never> {
        await this.hooks.executeRollback(
            () => this.rollback(),
            error
        );
        throw error;
    }

    private async commit(): Promise<void> {
        if (this.closed) {
            return;
        }

        this.closed = true;
        await this.client.query("COMMIT");
        this.transactionStarted = false;
        this.resources.clear();
        await this.clientCleanUp?.(this.client);
    }

    private async rollback(): Promise<void> {
        if (this.closed) {
            return;
        }

        this.closed = true;

        const client = this.client;
        try {
            if (this.transactionStarted && client) {
                await client.query("ROLLBACK");
            }
        } catch (e) {
            if (
                e instanceof Error &&
                e.message.includes("Client was closed and is not queryable")
            ) {
                return;
            }
            throw e;
        }

        this.resources.clear();
        this.transactionStarted = false;
        if (client) {
            await this.clientCleanUp?.(client);
        }
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
