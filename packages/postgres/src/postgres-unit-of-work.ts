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
    TransactionLifecycle,
    TransactionHook,
    UnitOfWorkClientAccess,
} from "@hexaijs/core";

/**
 * The cleanup the unit of work actually calls. It widens the public
 * `ClientCleanUp` with the failure that left the client in an unknown state,
 * so a pool-backed cleanup can destroy the client instead of reusing it.
 * Every `ClientCleanUp` is assignable to it, so the public type stays as is.
 */
type FailureAwareClientCleanUp = (
    client: pg.ClientBase,
    failure?: unknown
) => void | Promise<void>;

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

export interface PostgresUnitOfWorkObserver {
    onEveryCommit(observer: TransactionHook): () => void;
}

export interface PostgresUnitOfWork
    extends UnitOfWorkClientAccess<pg.ClientBase, PostgresTransactionOptions>,
        TransactionLifecycle,
        PostgresUnitOfWorkObserver {
    withClient<T>(fn: (client: pg.ClientBase) => Promise<T>): Promise<T>;
}

export class DefaultPostgresUnitOfWork
    implements PostgresUnitOfWork, CommitControl, TransactionResources {
    private static wrapDeprecationEmitted = false;
    private transactionStorage = new AsyncLocalStorage<PostgresTransaction>();
    private everyCommitObservers = new Set<TransactionHook>();

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

    async withClient<T>(fn: (client: pg.ClientBase) => Promise<T>): Promise<T> {
        const currentTransaction = this.getCurrentTransaction();

        if (currentTransaction) {
            const client = await currentTransaction.getClientLazy();
            // Finalization may have run between getClientLazy() resolving and
            // this line, for example when COMMIT throws synchronously and the
            // client is released at once.
            if (currentTransaction.isClosed()) {
                throw new TransactionClosedError("withClient()");
            }
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

    private resolveTransaction(
        options: PostgresTransactionOptions
    ): PostgresTransaction {
        if (options.propagation === Propagation.NEW) {
            return this.createTransaction();
        }
        return this.getCurrentTransaction() ?? this.createTransaction();
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

class PostgresTransaction {
    private startPromise: Promise<void> | null = null;
    private startInFlight = false;
    private startFailure?: { failure: unknown };
    private closingRollbackFailure?: {
        failure: unknown;
        reachedStarter: boolean;
    };
    private closingCleanUpFailure?: { failure: unknown };
    private propagatedCleanUpFailure?: { failure: unknown };
    private pendingSavepointStatements = new Set<Promise<void>>();
    private transactionStarted = false;
    private closed = false;
    private abortError?: Error;
    private commitPrevented = false;
    private commitPreventionCause?: unknown;

    private nestingDepth = 0;
    private nestedSavepointDepth = 0;
    private options!: PostgresTransactionOptions;

    private client!: pg.ClientBase;
    private clientCleanedUp = false;
    private savepoints: Savepoint[] = [];
    private hooks = new TransactionHooks();
    private resources = new Map<symbol, unknown>();

    constructor(
        private clientFactory: ClientFactory,
        private clientCleanUp: FailureAwareClientCleanUp | undefined,
        private notifyRootCommit: () => Promise<void>
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
        this.assertOpen("wrap()");
        await (this.nestingDepth === 0
            ? this.startRootWrap()
            : this.ensureStarted());
        // The transaction may have closed while the start was pending, and the
        // callback must never receive a client that was already released.
        this.assertOpen("wrap()");

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

        if (options.propagation === Propagation.NESTED) {
            this.assertOpen("scope()");
        }

        if (this.nestingDepth > 0 && options.propagation === Propagation.NESTED) {
            await this.ensureStarted();
            this.assertOpen("scope()");
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
        this.startInFlight = true;
        try {
            await this.initializeClient();
            if (this.closed) {
                await this.cleanUpClient();
                return;
            }

            try {
                await this.beginTransaction();
            } catch (startFailure) {
                // As in 0.15.0, the scope or wrap() that owns the transaction
                // ends it; the start only stands in for a finalizer that is
                // already waiting for it.
                this.startFailure = { failure: startFailure };
                if (this.closed) {
                    await this.endTransactionForWaitingFinalizer(startFailure);
                }
                throw startFailure;
            }

            if (this.closed) {
                await this.rollBackForWaitingFinalizer(true);
            }
        } finally {
            this.startInFlight = false;
        }
    }

    // A root wrap() whose start fails never reaches finalization, so 0.15.0
    // left its client checked out. Ending the transaction here is work 0.15.0
    // never did, so a failure while doing it is only reported, and the caller
    // still receives the start failure, as it did in 0.15.0.
    private async startRootWrap(): Promise<void> {
        try {
            await this.ensureStarted();
        } catch (startFailure) {
            this.closed = true;
            this.resources.clear();
            try {
                if (this.transactionStarted) {
                    await this.endTransaction("ROLLBACK");
                } else {
                    await this.cleanUpClient(startFailure);
                }
            } catch (endFailure) {
                console.error(
                    "PostgresUnitOfWork could not end a transaction whose start failed",
                    endFailure
                );
            }
            throw startFailure;
        }
    }

    private async endTransactionForWaitingFinalizer(
        startFailure: unknown
    ): Promise<void> {
        if (!this.transactionStarted) {
            // 0.15.0's finalizer released this client itself and surfaced a
            // cleanup failure, so the waiting finalizer gets it here too.
            try {
                await this.cleanUpClient(startFailure, true);
            } catch (cleanUpFailure) {
                this.closingCleanUpFailure = { failure: cleanUpFailure };
            }
            return;
        }

        try {
            await this.rollBackForWaitingFinalizer(false);
        } catch {
            // Kept for the waiting finalizer.
        }
    }

    // When a finalizer closed the transaction during the start, this ROLLBACK
    // stands in for the finalizer's own, so its failure is kept for the
    // finalizer. `reachesStarter` says whether the start also rejects with it,
    // which delivers it to the withClient() call that triggered the start.
    private async rollBackForWaitingFinalizer(
        reachesStarter: boolean
    ): Promise<void> {
        try {
            await this.endTransaction("ROLLBACK");
        } catch (failure) {
            if (this.propagatedCleanUpFailure?.failure === failure) {
                this.closingCleanUpFailure = { failure };
            } else {
                this.closingRollbackFailure = {
                    failure,
                    reachedStarter: reachesStarter,
                };
            }
            throw failure;
        }
    }

    // Finalization must not touch a client while its BEGIN or SET TRANSACTION
    // is still running. Once `closed` is set, doStart() ends the transaction
    // and releases that client itself, so waiting here is enough. A start
    // still waiting for a pooled client is not awaited: it holds no client
    // yet, releases the one it gets as soon as it sees `closed`, and waiting
    // could deadlock on a pool that an enclosing scope is holding.
    private async waitForStartOnAcquiredClient(): Promise<void> {
        if (!this.startInFlight || !this.client) {
            return;
        }

        try {
            await this.startPromise;
        } catch {
            // The withClient() call that triggered the start reports its failure.
        }
    }

    // 0.15.0 rolled back with its own ROLLBACK only when BEGIN had already
    // completed as finalization began; otherwise it released the client at
    // once and the scope never saw a later ROLLBACK failure. The start's
    // stand-in ROLLBACK keeps that split.
    // 0.15.0's finalizer always released the client itself and surfaced a
    // cleanup failure, whether or not it had sent ROLLBACK.
    private surfaceClosingCleanUpFailure(): void {
        if (this.closingCleanUpFailure) {
            throw this.closingCleanUpFailure.failure;
        }
    }

    private reportClosingRollbackFailure(rollbackWasDue: boolean): void {
        if (!this.closingRollbackFailure) {
            return;
        }

        const { failure, reachedStarter } = this.closingRollbackFailure;
        if (isClosedClientError(failure)) {
            return;
        }
        if (rollbackWasDue) {
            throw failure;
        }
        if (!reachedStarter) {
            console.error(
                "PostgresUnitOfWork could not roll back a transaction whose start failed",
                failure
            );
        }
    }

    // Savepoint statements are sent by the unit of work itself, so the final
    // COMMIT or ROLLBACK and the release wait for them instead of relying on
    // the driver to run statements in order. Their failures reach the nested
    // caller that sent them.
    private trackSavepointStatement(statement: Promise<unknown>): void {
        const settled = statement.then(
            () => undefined,
            () => undefined
        );
        this.pendingSavepointStatements.add(settled);
        void settled.then(() => this.pendingSavepointStatements.delete(settled));
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

        // A start still in flight here comes from work the callback did not
        // await; like a lazy no-op scope, it is rolled back, never committed.
        if (
            !this.startPromise ||
            !this.client ||
            !this.transactionStarted ||
            this.startInFlight
        ) {
            await this.closeWithoutDatabaseWork();
            return;
        }

        let committed = false;
        try {
            await this.hooks.executeCommit(
                async () => {
                    await this.commit();
                    committed = true;
                },
                () => this.rollback()
            );
        } finally {
            if (committed) {
                await this.notifyRootCommit();
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
            () => this.removeSavepoint(),
            () => this.isClosed(),
            (statement) => this.trackSavepointStatement(statement)
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
        if (this.isClosed()) {
            throw new TransactionClosedError(operation);
        }
    }

    private async closeWithoutDatabaseWork(): Promise<void> {
        this.closed = true;
        this.resources.clear();
        await this.waitForStartOnAcquiredClient();
        // As in 0.15.0, a lazy scope does not fail for work it did not await.
        this.reportClosingRollbackFailure(false);
        if (this.closingCleanUpFailure) {
            console.error(
                "PostgresUnitOfWork client cleanup failed after a transaction start",
                this.closingCleanUpFailure.failure
            );
        }

        // A start that failed before the scope finished still holds its
        // client, which 0.15.0 never released.
        if (this.startFailure) {
            await this.cleanUpClient(this.startFailure.failure);
        }
    }

    private async rollbackAndThrow(error: Error): Promise<never> {
        await this.hooks.executeRollback(
            () => this.rollback(),
            error
        );
        throw error;
    }

    // Unlike rollback(), commit() never waits for the start: the root scope
    // only commits once the start has settled successfully.
    private async commit(): Promise<void> {
        if (this.closed) {
            return;
        }

        this.closed = true;
        await this.endTransaction("COMMIT");
    }

    private async rollback(): Promise<void> {
        if (this.closed) {
            return;
        }

        this.closed = true;
        const rollbackWasDue = this.transactionStarted;
        await this.waitForStartOnAcquiredClient();
        this.surfaceClosingCleanUpFailure();
        this.reportClosingRollbackFailure(rollbackWasDue);

        if (!this.transactionStarted) {
            this.resources.clear();
            // 0.15.0 released the client here and surfaced a cleanup failure,
            // also after a failed BEGIN.
            await this.cleanUpClient(this.startFailure?.failure, true);
            return;
        }

        // A client closed underneath the transaction has nothing left to roll
        // back; the caller keeps seeing the error that caused the rollback.
        // Only the ROLLBACK statement gets this leniency: a cleanup failure
        // after a successful ROLLBACK still propagates.
        await this.endTransaction("ROLLBACK", { tolerateClosedClient: true });
    }

    private async endTransaction(
        statement: "COMMIT" | "ROLLBACK",
        { tolerateClosedClient = false } = {}
    ): Promise<void> {
        let failure: unknown;
        try {
            if (this.pendingSavepointStatements.size > 0) {
                await Promise.all(this.pendingSavepointStatements);
            }
            await this.client.query(statement);
        } catch (e) {
            failure = e;
            if (!(tolerateClosedClient && isClosedClientError(e))) {
                throw e;
            }
        } finally {
            this.transactionStarted = false;
            this.resources.clear();
            await this.cleanUpClient(failure);
        }
    }

    // `failure` marks a client in an unknown state, so the cleanup can destroy
    // it. `propagate` says whether a cleanup failure reaches the caller: it
    // does wherever 0.15.0 already cleaned up; cleanup that 0.15.0 never did
    // (it leaked the client) only reports its failure.
    private async cleanUpClient(
        failure?: unknown,
        propagate = failure === undefined
    ): Promise<void> {
        if (!this.client || this.clientCleanedUp) {
            return;
        }

        this.clientCleanedUp = true;

        try {
            if (failure === undefined) {
                await this.clientCleanUp?.(this.client);
            } else {
                await this.clientCleanUp?.(this.client, failure);
            }
        } catch (cleanUpFailure) {
            if (propagate) {
                this.propagatedCleanUpFailure = { failure: cleanUpFailure };
                throw cleanUpFailure;
            }
            console.error(
                "PostgresUnitOfWork client cleanup failed after a transaction failure",
                cleanUpFailure
            );
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
        private readonly onClose: () => void,
        private readonly isTransactionClosed: () => boolean,
        private readonly trackStatement: (statement: Promise<unknown>) => void
    ) {}

    public async execute<T>(
        fn: (client: pg.ClientBase) => Promise<T>
    ): Promise<T> {
        await this.ensureStarted();
        // The enclosing transaction may have closed while SAVEPOINT was
        // pending; its client must not reach the callback after release.
        this.assertTransactionOpen();
        return this.runWithLifecycle(fn);
    }

    public isClosed(): boolean {
        return this.closed;
    }

    private assertTransactionOpen(): void {
        if (this.isTransactionClosed()) {
            throw new TransactionClosedError("Nested savepoint");
        }
    }

    private async ensureStarted(): Promise<void> {
        if (this.initialized) {
            return;
        }

        this.assertTransactionOpen();
        this.initialized = true;
        await this.send(`SAVEPOINT ${this.name}`);
    }

    private async send(sql: string): Promise<void> {
        const statement = this.client.query(sql);
        this.trackStatement(statement);
        await statement;
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

    // Once the enclosing transaction has closed, its client may already be
    // back in the pool, where RELEASE or ROLLBACK TO would act on another
    // request's savepoint of the same name. The savepoint's work ended with
    // the enclosing transaction, so no SQL is sent.
    private async commit(): Promise<void> {
        if (this.closed) {
            return;
        }

        this.closed = true;
        if (this.isTransactionClosed()) {
            this.onClose();
            throw new TransactionClosedError("Nested savepoint");
        }

        await this.send(`RELEASE SAVEPOINT ${this.name}`);
        this.onClose();
    }

    private async rollback(): Promise<void> {
        if (this.closed) {
            return;
        }

        this.closed = true;
        if (!this.isTransactionClosed()) {
            await this.send(`ROLLBACK TO SAVEPOINT ${this.name}`);
        }
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

function releasePoolClient(client: pg.ClientBase, failure?: unknown): void {
    const poolClient = client as pg.PoolClient;
    if (failure === undefined) {
        poolClient.release();
        return;
    }

    // pg-pool destroys a client released with a truthy argument instead of
    // returning it to the pool in an unknown state.
    poolClient.release(failure instanceof Error ? failure : true);
}

function isClosedClientError(error: unknown): boolean {
    return (
        error instanceof Error &&
        error.message.includes("Client was closed and is not queryable")
    );
}
