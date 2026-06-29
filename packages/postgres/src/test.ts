import { AsyncLocalStorage } from "node:async_hooks";
import { Client, ClientBase } from "pg";

import { Propagation, TransactionHooks } from "@hexaijs/core";
import type { BeforeCommitOptions, TransactionHook } from "@hexaijs/core";
import { DatabaseManager, isDatabaseError, TableManager } from "./helpers.js";
import { PostgresConfig } from "./config/index.js";
import { runHexaiMigrations } from "./run-hexai-migrations.js";
import { PostgresTransactionOptions } from "./types.js";
import {
    PostgresUnitOfWork,
    UnsupportedNestedTransactionCapabilityError,
} from "./postgres-unit-of-work.js";
import type {
    CommitControl,
    TransactionResourceKey,
    TransactionResources,
} from "./postgres-unit-of-work.js";

export function createTestContext(dbUrl: string | PostgresConfig) {
    const config =
        typeof dbUrl === "string" ? PostgresConfig.fromUrl(dbUrl) : dbUrl;

    const dbName = config.database;
    const databaseManager = new DatabaseManager(
        config.withDatabase("postgres")
    );
    const tableManager = new TableManager(config);

    async function setup(): Promise<void> {
        try {
            await databaseManager.dropDatabase(dbName);
        } catch (e) {
            if (isDatabaseError(e) && e.code === "3D000") {
                // ignore
            } else {
                throw e;
            }
        }

        await databaseManager.createDatabase(dbName);
        await runHexaiMigrations(config);
    }

    async function teardown(): Promise<void> {
        await tableManager.close();
        await databaseManager.dropDatabase(dbName);
        await databaseManager.close();
    }

    return {
        client: tableManager.getClient(),
        newClient: () => new Client(dbUrl),
        tableManager,
        setup,
        teardown,
    };
}

export class PostgresUnitOfWorkForTesting
    implements PostgresUnitOfWork, CommitControl, TransactionResources {
    private executorStorage = new AsyncLocalStorage<TestTransactionExecutor>();
    private everyCommitObservers = new Set<TransactionHook>();

    constructor(private client: ClientBase) {}

    public getClient(): ClientBase {
        const executor = this.getCurrentExecutor();
        if (!executor) {
            throw new Error("Unit of work not started");
        }
        return this.client;
    }

    beforeCommit(
        hook: TransactionHook,
        options?: BeforeCommitOptions
    ): void {
        const executor = this.getRequiredExecutor("beforeCommit");
        executor.addBeforeCommitHook(hook, options);
    }

    afterCommit(hook: TransactionHook): void {
        const executor = this.getRequiredExecutor("afterCommit");
        executor.addAfterCommitHook(() =>
            this.runOutsideTransactionContext(hook)
        );
    }

    afterRollback(hook: TransactionHook): void {
        const executor = this.getRequiredExecutor("afterRollback");
        executor.addAfterRollbackHook(() =>
            this.runOutsideTransactionContext(hook)
        );
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
        const executor = this.getRequiredExecutor("preventCommit");
        executor.preventCommit(cause);
    }

    isCommitPrevented(): boolean {
        const executor = this.getRequiredExecutor("isCommitPrevented");
        return executor.isCommitPrevented();
    }

    getTransactionResource<T>(
        key: TransactionResourceKey<T>
    ): T | undefined {
        const executor = this.getRequiredExecutor("getTransactionResource");
        return executor.getResource(key);
    }

    getOrCreateTransactionResource<T>(
        key: TransactionResourceKey<T>,
        factory: () => T
    ): T {
        const executor = this.getRequiredExecutor(
            "getOrCreateTransactionResource"
        );
        return executor.getOrCreateResource(key, factory);
    }

    setTransactionResource<T>(
        key: TransactionResourceKey<T>,
        value: T
    ): void {
        const executor = this.getRequiredExecutor("setTransactionResource");
        executor.setResource(key, value);
    }

    async withClient<T>(fn: (client: ClientBase) => Promise<T>): Promise<T> {
        return fn(this.client);
    }

    async scope<T = unknown>(
        fn: () => Promise<T>,
        options: Partial<PostgresTransactionOptions> = {}
    ): Promise<T> {
        return this.wrap(fn, options);
    }

    async wrap<T = unknown>(
        fn: (client: ClientBase) => Promise<T>,
        options: Partial<PostgresTransactionOptions> = {}
    ): Promise<T> {
        const resolvedOptions = this.resolveOptions(options);
        const executor = this.resolveExecutor(resolvedOptions);

        return this.executeInContext(executor, (exec) =>
            exec.execute(fn, resolvedOptions)
        );
    }

    private getCurrentExecutor(): TestTransactionExecutor | null {
        return this.executorStorage.getStore() ?? null;
    }

    private runOutsideTransactionContext(
        hook: TransactionHook
    ): void | Promise<void> {
        return this.executorStorage.exit(() => hook());
    }

    private async notifyEveryCommit(): Promise<void> {
        const observers = Array.from(this.everyCommitObservers);
        if (observers.length === 0) {
            return;
        }

        await this.executorStorage.exit(async () => {
            for (const observer of observers) {
                try {
                    await observer();
                } catch (e) {
                    console.error(
                        "PostgresUnitOfWorkForTesting onEveryCommit observer failed",
                        e
                    );
                }
            }
        });
    }

    private getRequiredExecutor(hookName: string): TestTransactionExecutor {
        const executor = this.getCurrentExecutor();
        if (!executor) {
            throw new Error(
                `Cannot register ${hookName} hook outside of a transaction scope`
            );
        }
        return executor;
    }

    private resolveOptions(
        options: Partial<PostgresTransactionOptions>
    ): PostgresTransactionOptions {
        return {
            propagation: Propagation.EXISTING,
            ...options,
        };
    }

    private resolveExecutor(
        options: PostgresTransactionOptions
    ): TestTransactionExecutor {
        if (options.propagation === Propagation.NEW) {
            console.warn(
                "[PostgresUnitOfWorkForTesting] Propagation.NEW is not fully supported in testing mode. Using savepoint instead."
            );
            return this.createExecutor();
        }
        return this.getCurrentExecutor() ?? this.createExecutor();
    }

    private createExecutor(): TestTransactionExecutor {
        return new TestTransactionExecutor(
            this.client,
            () => this.notifyEveryCommit()
        );
    }

    private executeInContext<T>(
        executor: TestTransactionExecutor,
        callback: (executor: TestTransactionExecutor) => Promise<T>
    ): Promise<T> {
        return this.executorStorage.run(executor, () => callback(executor));
    }
}

class TestTransactionExecutor {
    private initialized = false;
    private closed = false;
    private abortError?: Error;
    private commitPrevented = false;
    private commitPreventionCause?: unknown;

    private nestingDepth = 0;
    private nestedSavepointDepth = 0;
    private savepointCounter = 0;
    private savepoints: TestSavepoint[] = [];
    private savepointName: string;
    private hooks = new TransactionHooks();
    private resources = new Map<symbol, unknown>();

    constructor(
        private readonly client: ClientBase,
        private notifyRootCommit: () => Promise<void>
    ) {
        this.savepointName = `test_sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

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
        fn: (client: ClientBase) => Promise<T>,
        options: PostgresTransactionOptions
    ): Promise<T> {
        await this.ensureStarted();

        const executor = this.resolveExecutor(options.propagation);
        return executor === this
            ? this.runWithLifecycle(fn)
            : this.runNestedSavepoint(() => executor.execute(fn, options));
    }

    public getClient(): ClientBase {
        return this.client;
    }

    private async ensureStarted(): Promise<void> {
        if (this.initialized) {
            return;
        }

        this.initialized = true;
        await this.client.query(`SAVEPOINT ${this.savepointName}`);
    }

    private async runWithLifecycle<T>(
        fn: (client: ClientBase) => Promise<T>
    ): Promise<T> {
        try {
            return await this.executeWithNesting(fn);
        } catch (e) {
            this.markAsAborted(e as Error);
            throw e;
        } finally {
            await this.finalizeIfRoot();
        }
    }

    private async executeWithNesting<T>(
        fn: (client: ClientBase) => Promise<T>
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
            if (this.isAborted() || this.commitPrevented) {
                await this.hooks.executeRollback(
                    () => this.rollback(),
                    this.abortError ?? this.commitPreventionCause
                );
            } else if (!this.closed) {
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
        }
    }

    private resolveExecutor(
        propagation: Propagation
    ): TestTransactionExecutor | TestSavepoint {
        if (this.nestingDepth === 0) {
            return this;
        }

        return propagation === Propagation.NESTED
            ? this.createSavepoint()
            : (this.findActiveSavepoint() ?? this);
    }

    private createSavepoint(): TestSavepoint {
        this.savepointCounter++;
        const savepoint = new TestSavepoint(
            `${this.savepointName}_nested_${this.savepointCounter}`,
            this.client,
            () => this.removeSavepoint()
        );
        this.savepoints.push(savepoint);
        return savepoint;
    }

    private findActiveSavepoint(): TestSavepoint | undefined {
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

    private async commit(): Promise<void> {
        if (this.closed) {
            return;
        }

        this.closed = true;
        await this.client.query(`RELEASE SAVEPOINT ${this.savepointName}`);
        this.resources.clear();
    }

    private async rollback(): Promise<void> {
        if (this.closed) {
            return;
        }

        this.closed = true;
        await this.client.query(
            `ROLLBACK TO SAVEPOINT ${this.savepointName}`
        );
        this.resources.clear();
    }

    private isAborted(): boolean {
        return this.abortError !== undefined && !this.closed;
    }
}

class TestSavepoint {
    private initialized = false;
    private closed = false;
    private abortError?: Error;

    private nestingDepth = 0;

    constructor(
        private readonly name: string,
        private readonly client: ClientBase,
        private readonly onClose: () => void
    ) {}

    public async execute<T>(
        fn: (client: ClientBase) => Promise<T>
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
        fn: (client: ClientBase) => Promise<T>
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
